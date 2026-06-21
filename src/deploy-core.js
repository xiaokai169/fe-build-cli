import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import SSHClient from './ssh-client.js';
import { DeployLogger, cleanLocalBackups } from './logger.js';

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
 * 使用 tar 管道流直传部署
 *
 * 原理:
 *   local: tar -czf - dist/   （打包到 stdout，不写临时文件）
 *     | pipe
 *   remote: ssh exec tar -xzf - -C /deploy/dir  （从 stdin 解压）
 *
 * 压缩、传输、解压三者流水线并行，不经过 SFTP 协议，不落临时文件。
 *
 * @param {object} options - 选项
 */
export async function pipeUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, skipBuild, logger } = options;

  // ====== A. 备份当前部署 ======
  await backupExistingDeployment({ ssh, envConfig, buildVersion, skipBuild, logger });

  // ====== B. 清空部署目录（保留受保护目录）======
  const stepNum = skipBuild ? '3' : '5';
  console.log(`\n[步骤 ${stepNum}/8] 准备部署目录...`);

  const protectedDirs = envConfig.protectedDirs || [];
  await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

  if (protectedDirs.length > 0) {
    console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
    const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
    await ssh.execCommand(
      `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
    );
  } else {
    await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
  }
  console.log('✅ 部署目录已就绪');

  // ====== C. tar 管道流直传（带进度） ======
  console.log(`\n[步骤 ${stepNum}/8] 流式传输 dist/ → ${envConfig.sshHost}...`);
  console.log('  (tar 管道: 压缩→传输→解压 流水线并行)');

  const sshPort = envConfig.sshPort || 22;
  const sshKeyPath = envConfig.sshKeyPath
    .replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/root')
    .replace(/\\/g, '/');
  const sshTarget = `${envConfig.sshUser}@${envConfig.sshHost}`;

  const startTime = Date.now();

  // 格式化
  const formatBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  try {
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-czf', '-', '-C', 'dist', '.']);
      const sshArgs = [
        '-T',  // 禁用伪终端，避免服务器登录 shell 的 stderr 混入
        '-i', sshKeyPath,
        '-p', String(sshPort),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=15',
        '-o', 'LogLevel=QUIET',
        sshTarget,
        `tar -xzf - -C ${envConfig.deployDir}`
      ];
      const sshProc = spawn('ssh', sshArgs);

      let bytesTransferred = 0;
      let lastUpdate = Date.now();

      tar.stdout.pipe(sshProc.stdin);

      tar.stdout.on('data', (chunk) => {
        bytesTransferred += chunk.length;
        const now = Date.now();
        // 每 200ms 更新一次进度
        if (now - lastUpdate > 200) {
          lastUpdate = now;
          const elapsed = (now - startTime) / 1000;
          const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
          process.stdout.write(`\r  已传输: ${formatBytes(bytesTransferred)}  ${formatBytes(speed)}/s  (${Math.round(elapsed)}s)`);
        }
      });

      tar.stderr.on('data', (data) => {
        // tar 的 stderr 有时是正常的（比如权限警告），不输出到控制台
      });

      sshProc.stderr.on('data', (data) => {
        process.stderr.write(data);
      });

      sshProc.on('close', (code) => {
        if (code === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          process.stdout.write(`\r  已传输: ${formatBytes(bytesTransferred)}  完成 (${Math.round(elapsed)}s)                    \n`);
          resolve(bytesTransferred);
        } else {
          reject(new Error(`SSH 退出码: ${code}`));
        }
      });

      tar.on('error', reject);
      sshProc.on('error', reject);
    });

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ 流式传输完成 (${duration}s)`);
    logger.logDeploy(envConfig.deployDir, true);
    logger.logUpload('dist/', envConfig.deployDir, 0, duration, true);
  } catch (error) {
    logger.logDeploy(envConfig.deployDir, false);
    logger.logUpload('dist/', envConfig.deployDir, 0, 0, false);

    // 尝试还原备份
    const latestBackup = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
    console.error('\n❌ 流式传输失败，尝试还原备份...');
    try {
      await ssh.execCommand(`tar -xzf ${latestBackup} -C ${envConfig.deployDir}`);
      console.log('✅ 已还原备份');
    } catch (restoreError) {
      console.error('⚠️  还原备份也失败了，请手动检查');
    }
    throw new Error(`管道传输失败: ${error.message}`);
  }
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

  // 传输策略：管道流直传 → SFTP 降级
  let usePipe = true;

  console.log('\n📌 使用 tar 管道流直传模式');

  try {
    await ssh.connect();
    logger.logSSHConnect(envConfig.sshHost, true);

    // ====== 方案A: tar 管道流直传 ======
    if (usePipe) {
      try {
        await pipeUploadDeploy({ ssh, envConfig, buildVersion, skipBuild, logger });
      } catch (pipeError) {
        console.log('\n⚠️  管道流失败，降级为 SFTP 上传...');
        usePipe = false;
      }
    }

    if (!usePipe) {
      // ====== 方案B: SFTP 上传（兜底）======
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
    if (usePipe) {
      console.log(`传输模式: tar 管道流直传`);
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
  pipeUploadDeploy,
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