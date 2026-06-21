import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import SSHClient from './ssh-client.js';
import { DeployLogger, cleanLocalBackups } from './logger.js';

/**
 * 检测本地是否安装了 rsync
 * @returns {boolean}
 */
export function checkRsyncAvailable() {
  try {
    execSync('rsync --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取服务器备份列表
 * @param {SSHClient} ssh - SSH 客户端
 * @param {object} envConfig - 环境配置
 * @returns {Promise<Array>} 备份文件列表
 */
export async function getServerBackupList(ssh, envConfig) {
  const listCommand = `ls -t ${envConfig.backupDir}/${envConfig.backupPrefix}*.tar.gz 2>/dev/null`;
  try {
    const result = await ssh.execCommand(listCommand);
    const files = result.trim().split('\n').filter(f => f.trim());
    
    // 解析文件名获取版本和时间信息
    return files.map(file => {
      const filename = path.basename(file);
      // 提取版本号：backup-production-build-20260618-abc123.tar.gz
      const match = filename.match(/^(.+)-build-(.+)\.tar\.gz$/);
      if (match) {
        return {
          file,
          filename,
          prefix: match[1],
          version: match[2],
          isServer: true
        };
      }
      return {
        file,
        filename,
        version: filename.replace(/\.tar\.gz$/, ''),
        isServer: true
      };
    });
  } catch (error) {
    return [];
  }
}

/**
 * 获取本地备份列表
 * @param {string} localBackupDir - 本地备份目录
 * @param {string} backupPrefix - 备份文件前缀
 * @returns {Array} 备份文件列表
 */
export function getLocalBackupList(localBackupDir, backupPrefix) {
  if (!fs.existsSync(localBackupDir)) {
    return [];
  }

  const files = fs.readdirSync(localBackupDir);
  const backupFiles = files.filter(f => 
    f.endsWith('.tar.gz') && f.startsWith(backupPrefix)
  );

  // 按修改时间排序（最新的在前）
  backupFiles.sort((a, b) => {
    const statA = fs.statSync(path.join(localBackupDir, a));
    const statB = fs.statSync(path.join(localBackupDir, b));
    return statB.mtimeMs - statA.mtimeMs;
  });

  return backupFiles.map(filename => {
    const filePath = path.join(localBackupDir, filename);
    const stats = fs.statSync(filePath);
    
    // 提取版本号
    const match = filename.match(/^(.+)-build-(.+)\.tar\.gz$/);
    if (match) {
      return {
        file: filePath,
        filename,
        prefix: match[1],
        version: match[2],
        mtime: stats.mtime,
        size: stats.size,
        isServer: false
      };
    }
    return {
      file: filePath,
      filename,
      version: filename.replace(/\.tar\.gz$/, ''),
      mtime: stats.mtime,
      size: stats.size,
      isServer: false
    };
  });
}

/**
 * 从本地备份执行回滚（上传到服务器后回滚）
 * @param {object} options - 回滚选项
 */
export async function rollbackFromLocal(options) {
  const { ssh, envConfig, localBackupFile, logger } = options;
  
  console.log('\n[步骤] 上传本地备份到服务器...');
  
  const remoteFile = `${envConfig.backupDir}/${path.basename(localBackupFile)}`;
  
  try {
    await ssh.uploadFile(localBackupFile, remoteFile);
    logger.logUpload(localBackupFile, remoteFile, fs.statSync(localBackupFile).size, 0, true);
    console.log('✅ 本地备份已上传到服务器');
    
    // 执行回滚
    return remoteFile;
  } catch (error) {
    logger.logUpload(localBackupFile, remoteFile, 0, 0, false);
    throw new Error(`上传本地备份失败: ${error.message}`);
  }
}

/**
 * 构建项目
 * @param {object} envConfig - 环境配置
 * @param {string} buildVersion - 构建版本号
 * @param {DeployLogger} logger - 日志记录器
 */
export function buildProject(envConfig, buildVersion, logger) {
  console.log('\n[步骤 1/8] 构建项目...');
  const buildMode = envConfig.buildMode || 'production';
  const buildCommand = envConfig.buildCommand || (buildMode === 'production' ? 'yarn build-only' : 'yarn build-test');
  console.log(`构建模式: ${buildMode} → ${buildCommand}`);
  
  const startTime = Date.now();
  process.env.VITE_APP_VERSION = buildVersion;
  
  try {
    execSync(buildCommand, { stdio: 'inherit' });
    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.logBuild(buildMode, buildVersion, true, duration);
    console.log('✅ 构建完成');
  } catch (error) {
    logger.logBuild(buildMode, buildVersion, false, 0);
    throw error;
  }
}

/**
 * 验证构建输出
 * @param {boolean} skipBuild - 是否跳过构建
 * @param {DeployLogger} logger - 日志记录器
 */
export function verifyBuildOutput(skipBuild, logger) {
  console.log(skipBuild ? '\n[步骤 1/7] 验证构建输出...' : '\n[步骤 2/8] 验证构建输出...');
  if (!fs.existsSync('dist')) {
    logger.log('ERROR', '验证构建', '构建目录不存在');
    process.exit(1);
  }
  logger.log('SUCCESS', '验证构建', '构建目录验证成功');
  console.log('✅ 验证完成');
}

/**
 * 压缩构建产物
 * @param {string} localZipFile - 本地压缩包路径
 * @param {boolean} skipBuild - 是否跳过构建
 * @param {DeployLogger} logger - 日志记录器
 */
export function compressBuild(localZipFile, skipBuild, logger) {
  console.log(skipBuild ? '\n[步骤 2/7] 压缩本地构建产物...' : '\n[步骤 3/8] 压缩本地构建产物...');
  
  try {
    execSync(`tar -czf ${localZipFile} -C dist .`, { stdio: 'inherit' });
    const stats = fs.statSync(localZipFile);
    logger.logCompress(stats.size, true);
    console.log('✅ 压缩完成');
  } catch (error) {
    logger.logCompress(0, false);
    throw error;
  }
}

/**
 * 备份现有部署
 * @param {object} options - 选项
 */
export async function backupExistingDeployment(options) {
  const { ssh, envConfig, buildVersion, skipBuild, logger } = options;
  const stepNum = skipBuild ? '3' : '4';
  console.log(`\n[步骤 ${stepNum}/8] 备份现有部署...`);
  const backupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;

  await ssh.execCommand(`mkdir -p ${envConfig.backupDir}`);
  await ssh.execCommand(`ls -la ${envConfig.deployDir} || echo '部署目录可能不存在'`);

  const checkDirCommand = `[ -d ${envConfig.deployDir} ] && [ "$(ls -A ${envConfig.deployDir} 2>/dev/null)" ] && echo 'has_files' || echo 'empty'`;
  const checkResult = await ssh.execCommand(checkDirCommand);

  if (checkResult.includes('has_files')) {
    console.log('部署目录非空,开始备份...');
    // 排除受保护目录，减小备份体积并避免权限问题
    const protectedDirs = envConfig.protectedDirs || [];
    const excludeArgs = protectedDirs.map(d => `--exclude='./${d}'`).join(' ');
    await ssh.execCommand(`tar -czf ${backupFile} ${excludeArgs} -C ${envConfig.deployDir} .`);
    logger.logBackup(backupFile, true);
    console.log('✅ 备份完成');

    await ssh.execCommand(
      `ls -t ${envConfig.backupDir}/${envConfig.backupPrefix}*.tar.gz 2>/dev/null | tail -n +2 | xargs rm -f`
    );
    console.log('✅ 清理旧备份完成');
  } else {
    logger.log('INFO', '服务器备份', '部署目录为空或不存在,跳过备份');
    console.log('部署目录为空或不存在,跳过备份');
  }
}

/**
 * 使用 RSYNC 增量部署（替代 compressBuild + uploadBuild + deployAndExtract）
 *
 * 流程:
 *   1. rsync --delete dist/ → 服务器持久化镜像目录 (增量同步, 只传变更文件)
 *   2. 服务器本地 cp 镜像 → 交换目录 (毫秒级)
 *   3. 备份当前 deployDir (复用现有逻辑)
 *   4. rm deployDir/* + mv 交换目录/* → deployDir (原子切换)
 *
 * @param {object} options - 选项
 */
export async function rsyncUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, skipBuild, logger } = options;

  // 持久化镜像目录 (保留在服务器上供下次增量比对)
  const mirrorDir = `${envConfig.backupDir}/.rsync-mirror`;
  // 交换目录 (与 deployDir 同层级, 确保 mv 原子操作)
  const swapDir = `${envConfig.deployDir}.swap`;

  // 构建 rsync SSH 连接参数
  const sshPort = envConfig.sshPort || 22;
  const sshKeyPath = envConfig.sshKeyPath
    .replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/root')
    .replace(/\\/g, '/'); // Windows: 将反斜杠转为正斜杠，防止 shell 转义
  const rshCmd = `ssh -i "${sshKeyPath}" -p ${sshPort} -o StrictHostKeyChecking=no -o ConnectTimeout=15`;
  const remoteTarget = `${envConfig.sshUser}@${envConfig.sshHost}:${mirrorDir}`;

  // ====== A. rsync 增量同步 ======
  console.log(`\n[RSYNC] 增量同步 dist/ → ${envConfig.sshHost}:${mirrorDir}`);
  console.log('  (首次全量, 后续仅传输变更文件)');

  const rsyncStartTime = Date.now();

  try {
    // 确保镜像目录存在
    await ssh.execCommand(`mkdir -p ${mirrorDir}`);

    // 使用 RSYNC_RSH 环境变量避免 -e 参数中的引号嵌套问题 (Windows 兼容)
    execSync(
      `rsync -avz --delete --no-perms --no-owner --no-group ./dist/ ${remoteTarget}/`,
      { stdio: 'inherit', env: { ...process.env, RSYNC_RSH: rshCmd } }
    );

    const rsyncDuration = Math.round((Date.now() - rsyncStartTime) / 1000);
    console.log(`✅ 增量同步完成 (${rsyncDuration}s)`);

    // 记录上传日志
    try {
      const mirrorSize = await ssh.execCommand(`du -sb ${mirrorDir} 2>/dev/null | cut -f1`);
      logger.logUpload('dist/', mirrorDir, parseInt(mirrorSize.trim()) || 0, rsyncDuration, true);
    } catch {
      logger.logUpload('dist/', mirrorDir, 0, rsyncDuration, true);
    }
  } catch (error) {
    logger.logUpload('dist/', mirrorDir, 0, 0, false);
    throw new Error(`rsync 同步失败: ${error.message}`);
  }

  // ====== B. 服务器本地拷贝镜像 → 交换目录 ======
  console.log('\n[RSYNC] 准备部署文件...');
  try {
    await ssh.execCommand(`rm -rf ${swapDir} && cp -a ${mirrorDir} ${swapDir}`);
    console.log('✅ 部署文件就绪');
  } catch (error) {
    throw new Error(`准备部署文件失败: ${error.message}`);
  }

  // ====== C. 备份当前部署 ======
  await backupExistingDeployment({ ssh, envConfig, buildVersion, skipBuild, logger });

  // ====== D. 原子切换 ======
  const stepNum = skipBuild ? '4' : '6';
  console.log(`\n[步骤 ${stepNum}/8] 部署到目标目录...`);

  const protectedDirs = envConfig.protectedDirs || [];

  // 确保目标目录存在
  await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

  // 清空部署目录 (保留受保护目录)
  if (protectedDirs.length > 0) {
    console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
    const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
    await ssh.execCommand(
      `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
    );
    console.log('✅ 已清理非保护目录');
  } else {
    await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
  }

  // 原子移动: mv 在同文件系统内是 rename 操作, 瞬间完成
  try {
    await ssh.execCommand(`sh -c 'mv ${swapDir}/* ${envConfig.deployDir}/ && rm -rf ${swapDir}'`);
    logger.logDeploy(envConfig.deployDir, true);
    console.log('✅ 部署切换完成');
  } catch (error) {
    logger.logDeploy(envConfig.deployDir, false);
    // 还原备份
    const latestBackup = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
    console.error('❌ 切换失败, 尝试还原备份...');
    try {
      await ssh.execCommand(`tar -xzf ${latestBackup} -C ${envConfig.deployDir}`);
      console.log('✅ 已还原备份');
    } catch (restoreError) {
      console.error('⚠️  还原备份也失败了, 请手动检查');
    }
    throw error;
  }

  // ====== E. 清理交换目录 ======
  await ssh.execCommand(`rm -rf ${swapDir}`);
}

/**
 * 上传构建产物
 * @param {object} options - 选项
 */
export async function uploadBuild(options) {
  const { ssh, localZipFile, remoteZipFile, skipBuild, logger } = options;
  const stepNum = skipBuild ? '4' : '5';
  console.log(`\n[步骤 ${stepNum}/8] 上传压缩包...`);
  
  const startTime = Date.now();
  const stats = fs.statSync(localZipFile);
  
  try {
    await ssh.uploadFile(localZipFile, remoteZipFile);
    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.logUpload(localZipFile, remoteZipFile, stats.size, duration, true);
    await ssh.execCommand(`ls -lh ${remoteZipFile}`);
    console.log('✅ 上传完成');
  } catch (error) {
    logger.logUpload(localZipFile, remoteZipFile, stats.size, 0, false);
    throw error;
  }
}

/**
 * 清理部署目录并解压新版本
 * @param {object} options - 选项
 */
export async function deployAndExtract(options) {
  const { ssh, envConfig, remoteZipFile, skipBuild, logger } = options;
  const stepNum = skipBuild ? '5' : '6';
  console.log(`\n[步骤 ${stepNum}/8] 清理并解压新版本...`);

  const protectedDirs = envConfig.protectedDirs || [];

  // 确保部署目录存在
  await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

  // 清空部署目录，但跳过受保护目录
  if (protectedDirs.length > 0) {
    console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
    const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
    await ssh.execCommand(
      `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
    );
    console.log('✅ 已清理非保护目录的文件');
  } else {
    await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
  }

  // 解压新版本
  try {
    await ssh.execCommand(`tar -xzf ${remoteZipFile} -C ${envConfig.deployDir}`);
    logger.logDeploy(envConfig.deployDir, true);
    console.log('✅ 清理并解压完成');
  } catch (error) {
    logger.logDeploy(envConfig.deployDir, false);
    throw error;
  }
}

/**
 * 清理临时文件
 * @param {object} options - 选项
 */
export async function cleanupFiles(options) {
  const { ssh, remoteZipFile, localZipFile, skipLocalCleanup, skipBuild, logger } = options;
  const stepNum = skipBuild ? '6' : '7';
  console.log(`\n[步骤 ${stepNum}/8] 删除压缩包...`);
  
  try {
    await ssh.execCommand(`rm -f ${remoteZipFile}`);
    if (!skipLocalCleanup) {
      fs.unlinkSync(localZipFile);
    }
    logger.log('SUCCESS', '清理临时文件', '压缩包已删除');
    console.log('✅ 删除完成');
  } catch (error) {
    logger.log('WARN', '清理临时文件', '删除压缩包失败,但不影响部署');
    console.warn('⚠️  删除压缩包失败,但不影响部署');
  }
}

/**
 * 下载线上备份到本地
 * @param {object} options - 选项
 */
export async function downloadBackup(options) {
  const { ssh, envConfig, buildVersion, localBackupDir, logger } = options;
  
  console.log('\n[步骤] 下载线上备份到本地...');
  
  // 确保本地备份目录存在
  if (!fs.existsSync(localBackupDir)) {
    fs.mkdirSync(localBackupDir, { recursive: true });
  }
  
  const remoteBackupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
  const localBackupFile = path.join(localBackupDir, `${envConfig.backupPrefix}-${buildVersion}.tar.gz`);
  
  // 检查远程备份文件是否存在
  const checkCommand = `test -f '${remoteBackupFile}' && echo 'FILE_YES' || echo 'FILE_NO'`;
  const exists = await ssh.execCommand(checkCommand);
  
  if (!exists.includes('FILE_YES')) {
    logger.log('WARN', '备份下载', '远程备份文件不存在');
    console.log('⚠️ 远程备份文件不存在，跳过下载');
    return null;
  }
  
  try {
    await ssh.downloadFile(remoteBackupFile, localBackupFile);
    logger.logBackup(localBackupFile, true, true);
    
    // 清理本地旧备份（保留7天）
    cleanLocalBackups(localBackupDir, 7);
    
    return localBackupFile;
  } catch (error) {
    logger.logBackup(remoteBackupFile, false, true);
    console.error('❌ 下载备份失败:', error.message);
    return null;
  }
}

/**
 * 执行部署到服务器
 * @param {object} options - 部署选项
 * @param {string} options.environment - 环境名称
 * @param {object} options.envConfig - 环境配置
 * @param {string} options.buildVersion - 构建版本
 * @param {boolean} options.skipBuild - 是否跳过构建
 * @param {boolean} options.skipLocalCleanup - 是否跳过本地清理
 * @param {DeployLogger} options.logger - 日志记录器
 * @param {string} options.localBackupDir - 本地备份目录
 */
export async function deployToServer(options) {
  const { environment, envConfig, buildVersion, skipBuild = false, skipLocalCleanup = false, logger, localBackupDir } = options;

  if (!skipBuild) {
    buildProject(envConfig, buildVersion, logger);
  }

  verifyBuildOutput(skipBuild, logger);

  const ssh = new SSHClient(envConfig);

  // 检测 rsync 可用性（优先使用 rsync 增量同步）
  const useRsync = checkRsyncAvailable();

  if (useRsync) {
    console.log('\n📌 检测到 rsync，使用增量同步模式');
  } else {
    console.log('\n📌 未检测到 rsync，使用 SFTP 上传模式');
  }

  try {
    await ssh.connect();
    logger.logSSHConnect(envConfig.sshHost, true);

    if (useRsync) {
      // ====== RSYNC 路径 ======
      await rsyncUploadDeploy({ ssh, envConfig, buildVersion, skipBuild, logger });
    } else {
      // ====== SFTP 路径（降级）======
      const localZipFile = `dist-${buildVersion}.tar.gz`;
      const remoteZipFile = `${envConfig.backupDir}/${localZipFile}`;

      compressBuild(localZipFile, skipBuild, logger);
      await backupExistingDeployment({ ssh, envConfig, buildVersion, skipBuild, logger });
      await uploadBuild({ ssh, localZipFile, remoteZipFile, skipBuild, logger });

      try {
        await deployAndExtract({ ssh, envConfig, remoteZipFile, skipBuild, logger });
      } catch (error) {
        console.error('❌ 清理或解压失败!');
        await ssh.disconnect();
        throw error;
      }

      try {
        await cleanupFiles({ ssh, remoteZipFile, localZipFile, skipLocalCleanup, skipBuild, logger });
      } catch (error) {
        console.warn('⚠️  删除压缩包失败,但不影响部署');
      }
    }

    // 下载线上备份到本地
    if (localBackupDir) {
      await downloadBackup({ ssh, envConfig, buildVersion, localBackupDir, logger });
    }

    await ssh.disconnect();

    if (!skipBuild) {
      fs.writeFileSync('deployed_version.txt', buildVersion);
    }

    console.log('\n========================================');
    console.log('✅ 部署成功完成!');
    console.log(`环境: ${environment}`);
    console.log(`版本: ${buildVersion}`);
    console.log(`服务器: ${envConfig.sshHost}`);
    console.log(`地址: ${envConfig.deployUrl}`);
    if (useRsync) {
      console.log(`传输模式: rsync 增量同步`);
    }
    console.log('========================================');

    logger.log('SUCCESS', '部署完成', `环境: ${environment}, 版本: ${buildVersion}`);
  } catch (error) {
    console.error('部署失败:', error);
    logger.log('ERROR', '部署失败', error.message);
    await ssh.disconnect();
    throw error;
  }
}

/**
 * 执行回滚
 * @param {object} options - 回滚选项
 * @param {string} options.environment - 环境名称
 * @param {object} options.envConfig - 环境配置
 * @param {string} options.specifiedVersion - 指定版本（可选）
 * @param {string} options.backupFile - 备份文件路径（可选，已选择）
 * @param {SSHClient} options.ssh - SSH 客户端（可选，已连接）
 * @param {DeployLogger} options.logger - 日志记录器
 */
export async function rollbackDeployment(options) {
  const { environment, envConfig, specifiedVersion, backupFile, ssh: existingSsh, logger } = options;

  console.log('========================================');
  console.log(`开始回滚 ${environment} 环境`);
  console.log(`服务器: ${envConfig.sshHost}`);
  console.log('========================================');

  // 使用已连接的 ssh 或创建新连接
  const ssh = existingSsh || new SSHClient(envConfig);
  let needDisconnect = !existingSsh;

  try {
    if (!existingSsh) {
      await ssh.connect();
      logger.logSSHConnect(envConfig.sshHost, true);
    }

    console.log('\n[步骤 1/4] 获取备份文件...');

    let finalBackupFile = backupFile;
    if (!finalBackupFile) {
      if (specifiedVersion) {
        finalBackupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${specifiedVersion}.tar.gz`;
        console.log(`使用指定版本: ${specifiedVersion}`);
      } else {
        const listCommand = `ls -t ${envConfig.backupDir}/${envConfig.backupPrefix}*.tar.gz 2>/dev/null | head -n 1`;
        try {
          const listResult = await ssh.execCommand(listCommand);
          finalBackupFile = listResult.trim();

          if (!finalBackupFile) {
            logger.log('ERROR', '获取备份', '未找到备份文件');
            console.error('❌ 未找到备份文件!');
            if (needDisconnect) await ssh.disconnect();
            process.exit(1);
          }
          console.log(`找到最新备份: ${finalBackupFile}`);
          logger.log('SUCCESS', '获取备份', `找到最新备份: ${finalBackupFile}`);
        } catch (error) {
          logger.log('ERROR', '获取备份', '获取备份文件失败');
          console.error('❌ 获取备份文件失败!');
          if (needDisconnect) await ssh.disconnect();
          process.exit(1);
        }
      }
    }

    console.log('\n[步骤 2/4] 验证备份文件...');
    const checkCommand = `test -f '${finalBackupFile}' && echo 'FILE_YES' || echo 'FILE_NO'`;
    const exists = await ssh.execCommand(checkCommand);

    if (!exists.includes('FILE_YES')) {
      logger.log('ERROR', '验证备份', `备份文件不存在: ${finalBackupFile}`);
      console.error(`❌ 备份文件不存在: ${finalBackupFile}`);
      if (needDisconnect) await ssh.disconnect();
      process.exit(1);
    }
    logger.log('SUCCESS', '验证备份', '备份文件验证完成');
    console.log('✅ 备份文件验证完成');

    const protectedDirs = envConfig.protectedDirs || [];

    console.log('\n[步骤 3/4] 执行回滚...');

    try {
      await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

      if (protectedDirs.length > 0) {
        console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
        const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
        await ssh.execCommand(
          `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
        );
        console.log('✅ 已清理非保护目录的文件');
      } else {
        await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
      }

      if (protectedDirs.length > 0) {
        const excludeArgs = protectedDirs.map(d => `--exclude='./${d}'`).join(' ');
        await ssh.execCommand(`tar -xzf ${finalBackupFile} ${excludeArgs} -C ${envConfig.deployDir}`);
      } else {
        await ssh.execCommand(`tar -xzf ${finalBackupFile} -C ${envConfig.deployDir}`);
      }
      logger.logDeploy(envConfig.deployDir, true);
      console.log('✅ 回滚成功');
    } catch (error) {
      logger.logDeploy(envConfig.deployDir, false);
      console.error('❌ 回滚失败!');
      if (needDisconnect) await ssh.disconnect();
      process.exit(1);
    }

    console.log('\n[步骤 4/4] 验证回滚...');
    try {
      const verifyResult = await ssh.execCommand(`ls -la ${envConfig.deployDir} | head -n 20`);
      console.log('=== 验证回滚后的文件 ===');
      console.log(verifyResult);
      logger.log('SUCCESS', '验证回滚', '验证完成');
      console.log('✅ 验证完成');
    } catch (error) {
      logger.log('ERROR', '验证回滚', '验证失败');
      console.error('❌ 验证失败!');
      if (needDisconnect) await ssh.disconnect();
      process.exit(1);
    }

    if (needDisconnect) {
      await ssh.disconnect();
    }

    console.log('\n========================================');
    console.log('✅ 回滚成功完成!');
    console.log(`环境: ${environment}`);
    console.log(`服务器: ${envConfig.sshHost}`);
    console.log(`备份文件: ${finalBackupFile}`);
    console.log('========================================');
    
    logger.log('SUCCESS', '回滚完成', `备份文件: ${finalBackupFile}`);
  } catch (error) {
    console.error('回滚失败:', error);
    logger.log('ERROR', '回滚失败', error.message);
    if (needDisconnect) {
      try {
        await ssh.disconnect();
      } catch (e) {
        // 忽略
      }
    }
    throw error;
  }
}

export default {
  checkRsyncAvailable,
  rsyncUploadDeploy,
  buildProject,
  verifyBuildOutput,
  compressBuild,
  backupExistingDeployment,
  uploadBuild,
  deployAndExtract,
  cleanupFiles,
  downloadBackup,
  deployToServer,
  rollbackDeployment
};