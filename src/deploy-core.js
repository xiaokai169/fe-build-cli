import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import SSHClient from './ssh-client.js';
import { DeployLogger, cleanLocalBackups } from './logger.js';
import { formatBytes, shellEscape, parseBackupFilename, expandTilde, isWindows } from './utils.js';

/**
 * 获取服务器备份列表
 * @param {SSHClient} ssh - SSH 客户端
 * @param {object} envConfig - 环境配置
 * @returns {Promise<Array>} 备份文件列表
 */
export async function getServerBackupList(ssh, envConfig) {
  const listCommand = `ls -t ${shellEscape(envConfig.backupDir)}/${shellEscape(envConfig.backupPrefix)}*.tar.gz 2>/dev/null`;
  try {
    const result = await ssh.execCommand(listCommand);
    const files = result.trim().split('\n').filter(f => f.trim());

    // 解析文件名获取版本和时间信息
    return files.map(file => {
      const filename = path.basename(file);
      const parsed = parseBackupFilename(filename);
      if (parsed) {
        return {
          file,
          filename,
          prefix: parsed.prefix,
          version: parsed.version,
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

    const parsed = parseBackupFilename(filename);
    if (parsed) {
      return {
        file: filePath,
        filename,
        prefix: parsed.prefix,
        version: parsed.version,
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
  console.log('\n[步骤 1/7] 构建项目...');
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
  console.log(skipBuild ? '\n[步骤 2/7] 验证构建输出...' : '\n[步骤 2/7] 验证构建输出...');
  if (!fs.existsSync('dist')) {
    logger.log('ERROR', '验证构建', '构建目录不存在');
    process.exit(1);
  }
  logger.log('SUCCESS', '验证构建', '构建目录验证成功');
  console.log('✅ 验证完成');
}

/**
 * 压缩构建产物（仅 SFTP 降级模式使用）
 * @param {string} localZipFile - 本地压缩包路径
 * @param {DeployLogger} logger - 日志记录器
 */
export async function compressBuild(localZipFile, logger) {
  console.log('\n[步骤 3/7] 压缩本地构建产物...');

  try {
    // tar 输出 → Node.js 内置 zlib 流式 gzip → 写入文件
    // 不依赖外部 gzip/zstd 命令，所有平台开箱即用
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-cf', '-', '-C', 'dist', '.']);
      const gzip = zlib.createGzip();
      const out = fs.createWriteStream(localZipFile);

      // 静默 tar 权限警告（跨平台权限差异）
      tar.stderr.on('data', () => {});

      tar.stdout.pipe(gzip).pipe(out);

      let finished = false;
      const done = (err) => {
        if (finished) return;
        finished = true;
        err ? reject(err) : resolve();
      };

      out.on('finish', () => done());
      out.on('error', done);
      tar.on('error', done);
      gzip.on('error', done);
    });

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
 * @param {string} [options.suffix] - 备份文件名后缀（用于降级模式避免覆盖管道流备份）
 */
export async function backupExistingDeployment(options) {
  const { ssh, envConfig, buildVersion, logger, suffix = '' } = options;
  console.log('\n[步骤] 备份现有部署...');
  const backupFile = suffix
    ? `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}${suffix}.tar.gz`
    : `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;

  const mkdirCmd = `mkdir -p ${shellEscape(envConfig.backupDir)}`;
  await ssh.execCommand(mkdirCmd);
  await ssh.execCommand(`ls -la ${shellEscape(envConfig.deployDir)} || echo '部署目录可能不存在'`);

  const checkDirCommand = `[ -d ${shellEscape(envConfig.deployDir)} ] && [ "$(ls -A ${shellEscape(envConfig.deployDir)} 2>/dev/null)" ] && echo 'has_files' || echo 'empty'`;
  const checkResult = await ssh.execCommand(checkDirCommand);

  if (checkResult.includes('has_files')) {
    console.log('部署目录非空,开始备份...');
    // 排除受保护目录，减小备份体积并避免权限问题
    const protectedDirs = envConfig.protectedDirs || [];
    const excludeArgs = protectedDirs.map(d => `--exclude=${shellEscape('./' + d)}`).join(' ');
    const tarCmd = `tar -czf ${shellEscape(backupFile)} ${excludeArgs} -C ${shellEscape(envConfig.deployDir)} .`;
    await ssh.execCommand(tarCmd);
    logger.logBackup(backupFile, true);
    console.log('✅ 备份完成');

    // 清理旧备份：使用 find 按时间排序，可靠地删除旧文件
    // 保留最新 N 个备份（默认1个），其余删除
    const retentionCount = envConfig.backupRetentionCount || 1;
    const cleanupCmd = `cd ${shellEscape(envConfig.backupDir)} 2>/dev/null && ` +
      `ls -t ${shellEscape(envConfig.backupPrefix)}*.tar.gz 2>/dev/null | ` +
      `tail -n +${retentionCount + 1} | xargs -r rm -f`;
    await ssh.execCommand(cleanupCmd);
    console.log('✅ 清理旧备份完成');
  } else {
    logger.log('INFO', '服务器备份', '部署目录为空或不存在,跳过备份');
    console.log('部署目录为空或不存在,跳过备份');
  }
}

/**
 * 原子替换部署目录：将临时目录切换为正式目录（零空窗期）
 *
 * 使用 mv 批量移动而非逐文件处理，减少 SSH 往返。
 * 有受保护目录时，先移除非保护文件，再移入新文件。
 *
 * @param {object} options
 */
async function swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs }) {
  const deployDirEsc = shellEscape(envConfig.deployDir);
  const tmpDirEsc = shellEscape(tmpDeployDir);

  if (protectedDirs && protectedDirs.length > 0) {
    // 有受保护目录：先清除非保护内容，再从临时目录移入新文件
    console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
    const excludeArgs = protectedDirs.map(d => `! -name ${shellEscape(d)}`).join(' ');
    // 只删除 deployDir 中非保护的文件和目录
    const findCmd = `find ${deployDirEsc} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} + 2>/dev/null; `;
    // 从临时目录移入新文件，然后清理临时目录
    await ssh.execCommand(
      `${findCmd}find ${tmpDirEsc} -maxdepth 1 -mindepth 1 -exec mv {} ${deployDirEsc}/ \\; 2>/dev/null; rm -rf ${tmpDirEsc}`
    );
  } else {
    // 无受保护目录：先确保目录存在，删除内容，再移入新文件
    // 删除内容而非删除目录本身，避免父目录权限问题
    await ssh.execCommand(
      `mkdir -p ${deployDirEsc} && ` +
      `rm -rf ${deployDirEsc}/* ${deployDirEsc}/.[!.]* && ` +
      `find ${tmpDirEsc} -mindepth 1 -maxdepth 1 -exec mv -t ${deployDirEsc}/ {} + && ` +
      `rm -rf ${tmpDirEsc}`
    );
  }
}

/**
 * 使用 tar 管道流直传部署
 *
 * 原理:
 *   local: tar -czf - dist/   （gzip 压缩到 stdout，不写临时文件）
 *     | pipe
 *   remote: ssh exec tar -xf - -C /deploy/dir  （从 stdin 自动检测格式解压）
 *
 * 压缩、传输、解压三者流水线并行，不经过 SFTP 协议，不落临时文件。
 *
 * @param {object} options - 选项
 */
export async function pipeUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, logger, skipBackup = false } = options;

  // ====== A. 备份当前部署 ======
  if (!skipBackup) {
    await backupExistingDeployment({ ssh, envConfig, buildVersion, logger });
  } else {
    console.log('  (跳过备份，前面策略已创建)');
  }

  // ====== B. 准备临时目录（避免部署空窗期导致 403）======
  console.log('\n[步骤 3/7] 准备临时部署目录...');

  const protectedDirs = envConfig.protectedDirs || [];
  const tmpDeployDir = `${envConfig.backupDir}/deploy-tmp`;
  const tmpDirEsc = shellEscape(tmpDeployDir);
  const deployDirEsc = shellEscape(envConfig.deployDir);

  // 确保临时目录存在且为空
  await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);
  // 确保部署目录也存在（首次部署）
  await ssh.execCommand(`mkdir -p ${deployDirEsc}`);
  console.log('✅ 临时部署目录已就绪');

  // ====== C. tar 管道流直传 → 临时目录（带进度） ======
  console.log(`\n[步骤 4/7] 流式传输 dist/ → ${envConfig.sshHost}...`);
  console.log('  (tar 管道: 压缩→传输→解压 流水线并行，复用已有 SSH 连接)');

  const startTime = Date.now();
  let tar = null; // 声明在外层，确保 catch 中可清理

  try {
    // 使用已有 SSH 连接传输，不再 spawn 第二条 ssh 连接
    tar = spawn('tar', ['-czf', '-', '-C', 'dist', '.']);

    let bytesTransferred = 0;
    let lastUpdate = Date.now();

    const onProgress = () => {
      const now = Date.now();
      if (now - lastUpdate > 200) {
        lastUpdate = now;
        const elapsed = (now - startTime) / 1000;
        const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
        const barW = 20;
        const tick = Math.floor((elapsed * 4) % barW);
        const bar = '░'.repeat(tick) + '█' + '░'.repeat(Math.max(0, barW - tick - 1));
        process.stdout.write(`\r  [${bar}] ${formatBytes(bytesTransferred)}  ${formatBytes(speed)}/s  ${Math.round(elapsed)}s`);
      }
    };

    tar.stderr.on('data', () => { /* 静默 tar 权限警告 */ });

    // 同时监听 tar 进程错误和 SSH 管道传输结果，谁先出错谁触发 reject
    const tarError = new Promise((_, reject) => {
      tar.on('error', reject);
    });

    // 使用已有 SSH 连接传输（不再 spawn 第二条连接，避免 MaxSessions 冲突）
    bytesTransferred = await Promise.race([
      ssh.pipeExec(
        `tar -xf - -C ${tmpDeployDir}`,
        tar.stdout,
        (written) => { bytesTransferred = written; onProgress(); }
      ),
      tarError
    ]);

    const elapsed = (Date.now() - startTime) / 1000;
    process.stdout.write(`\r  传输完成: ${formatBytes(bytesTransferred)}  ${Math.round(elapsed)}s                    \n`);

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ 流式传输完成 (${duration}s)`);

    // ====== D. 原子替换：将临时目录切换为正式部署目录 ======
    console.log('\n[步骤 5/7] 原子替换部署目录...');
    await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });

    console.log('✅ 部署目录已切换（零空窗期）');
    logger.logDeploy(envConfig.deployDir, true);
    logger.logUpload('dist/', envConfig.deployDir, 0, duration, true);
  } catch (error) {
    // 确保 tar 子进程被终止，避免僵尸进程
    if (tar && !tar.killed) {
      try { tar.kill('SIGTERM'); } catch { /* 忽略 */ }
    }

    logger.logDeploy(envConfig.deployDir, false);
    logger.logUpload('dist/', envConfig.deployDir, 0, 0, false);

    // 清理临时目录
    console.error('\n❌ 流式传输失败，清理临时目录...');
    try {
      await ssh.execCommand(`rm -rf ${tmpDirEsc}`);
    } catch { /* 忽略 */ }

    // 尝试还原备份
    const latestBackup = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
    console.error('尝试还原备份...');
    try {
      await ssh.execCommand(`tar -xf ${shellEscape(latestBackup)} -C ${deployDirEsc}`);
      console.log('✅ 已还原备份');
    } catch (restoreError) {
      console.error('⚠️  还原备份也失败了，请手动检查');
    }
    throw new Error(`管道传输失败: ${error.message}`);
  }
}


/**
 * 上传构建产物（SFTP 降级模式）
 * @param {object} options - 选项
 */
export async function uploadBuild(options) {
  const { ssh, localZipFile, remoteZipFile, logger } = options;
  console.log('\n[步骤 5/7] 上传压缩包...');

  const startTime = Date.now();
  const stats = fs.statSync(localZipFile);

  try {
    await ssh.uploadFile(localZipFile, remoteZipFile);
    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.logUpload(localZipFile, remoteZipFile, stats.size, duration, true);
    await ssh.execCommand(`ls -lh ${shellEscape(remoteZipFile)}`);
    console.log('✅ 上传完成');
  } catch (error) {
    logger.logUpload(localZipFile, remoteZipFile, stats.size, 0, false);
    throw error;
  }
}

/**
 * 清理部署目录并解压新版本（零空窗期：先解压到 backupDir 临时目录再原子替换）
 *
 * @param {object} options - 选项
 */
export async function deployAndExtract(options) {
  const { ssh, envConfig, remoteZipFile, logger } = options;
  console.log('\n[步骤 6/7] 解压新版本到临时目录...');

  const protectedDirs = envConfig.protectedDirs || [];
  const tmpDeployDir = `${envConfig.backupDir}/deploy-tmp`;
  const tmpDirEsc = shellEscape(tmpDeployDir);
  const remoteZipEsc = shellEscape(remoteZipFile);

  // 准备临时目录
  await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);

  // 解压新版本到 backupDir 下的临时目录
  try {
    await ssh.execCommand(`tar -xf ${remoteZipEsc} -C ${tmpDirEsc}`);
    console.log('✅ 解压完成');

    // 原子替换（复用 swapDeployDir，有 protectedDirs 时不删受保护目录）
    await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });

    logger.logDeploy(envConfig.deployDir, true);
    console.log('✅ 部署目录已切换（零空窗期）');
  } catch (error) {
    logger.logDeploy(envConfig.deployDir, false);
    // 清理临时目录
    try { await ssh.execCommand(`rm -rf ${tmpDirEsc}`); } catch { /* 忽略 */ }
    throw error;
  }
}

/**
 * 清理临时文件
 * @param {object} options - 选项
 */
export async function cleanupFiles(options) {
  const { ssh, remoteZipFile, localZipFile, skipLocalCleanup, logger } = options;
  console.log('\n[步骤 7/7] 删除压缩包...');

  try {
    await ssh.execCommand(`rm -f ${shellEscape(remoteZipFile)}`);
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
  const checkCommand = `test -f ${shellEscape(remoteBackupFile)} && echo 'FILE_YES' || echo 'FILE_NO'`;
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
 * 将 HTTPS Git 地址转为 SSH 格式（服务器无 HTTPS 认证时自动使用）
 * 仅处理 github.com / gitlab.com / gitee.com，其他原样返回
 */
function toSSHUrl(url) {
  // 已经是 SSH 格式
  if (url.startsWith('git@')) return url;
  // 尝试转换常见平台
  const match = url.match(/^https?:\/\/([^/]+)\/(.+?)(\.git)?$/);
  if (match && ['github.com', 'gitlab.com', 'gitee.com'].includes(match[1])) {
    return `git@${match[1]}:${match[2]}.git`;
  }
  return url;
}

// ====== Git 中转部署（通过项目的 release 分支） ======

/**
 * Git 中转部署模式（基于 orphan 分支）
 *
 * 在当前项目中创建独立的 release 分支，只存放构建产物压缩包。
 * 分支与源码历史完全隔离（orphan），不污染主分支。
 *
 * 流程:
 *   1. 备份现有部署
 *   2. 压缩本地构建产物 → dist-{version}.tar.gz
 *   3. 切换到 release 分支，提交压缩包并推送
 *   4. SSH 服务器拉取 release 分支 → 解压 → 原子替换
 *   5. 切回原分支，清理临时文件
 *
 * 配置:
 *   gitRelease: {
 *     branch: 'release'  // 发布分支名，默认 'release'
 *   }
 *
 * @param {object} options
 */
export async function gitUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, logger, skipBackup = false } = options;
  const releaseBranch = envConfig.gitRelease?.branch || 'release';

  // ====== A. 备份当前部署 ======
  if (!skipBackup) {
    await backupExistingDeployment({ ssh, envConfig, buildVersion, logger });
  } else {
    console.log('  (跳过备份，前面策略已创建)');
  }

  // ====== B. 压缩构建产物 ======
  const localZipFile = `dist-${buildVersion}.tar.gz`;
  await compressBuild(localZipFile, logger);

  // ====== C. 本地推送 release 分支 ======
  console.log(`\n[步骤 5/7] 推送构建产物到 ${releaseBranch} 分支...`);

  const zipBaseName = path.basename(localZipFile);
  let currentBranch = '';

  try {
    // 获取 origin URL（服务器拉取时需要）
    let originUrl = '';
    try {
      originUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    } catch {
      throw new Error('无法获取 git remote origin，请确认已配置 git 远程仓库');
    }

    // 记住当前分支
    currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();

    // ====== 保护未提交的改动: 自动 stash ======
    let stashCreated = false;
    try {
      // 检查是否有任何未提交的改动（包括 untracked）
      const statusCheck = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
      if (statusCheck) {
        console.log('  📦 检测到未提交改动，自动 stash 保护...');
        execSync('git stash push -u -m "fe-build-cli: auto stash before deploy"', { stdio: 'inherit' });
        stashCreated = true;
        console.log('  ✅ 未提交改动已 stash，部署完成后自动恢复');
      }
    } catch (e) {
      console.warn('  ⚠️  stash 失败，部署将继续但未提交改动可能丢失');
    }

    // 创建或切换到 release 分支
    let releaseExists = false;
    try {
      execSync(`git rev-parse --verify "${releaseBranch}"`, { stdio: 'pipe' });
      releaseExists = true;
    } catch {
      releaseExists = false;
    }

    if (releaseExists) {
      execSync(`git checkout -f "${releaseBranch}"`, { stdio: 'pipe' });
      // 清空分支内容
      execSync('git rm -rf . 2>nul || git rm -rf . 2>/dev/null || true', { stdio: 'pipe' });
    } else {
      // 首次：创建无历史的 orphan 分支
      execSync(`git checkout --orphan "${releaseBranch}"`, { stdio: 'pipe' });
      execSync('git rm -rf --cached . 2>nul || git rm -rf --cached . 2>/dev/null || true', { stdio: 'pipe' });
      console.log(`  已创建独立的 ${releaseBranch} 分支（orphan，与源码历史隔离）`);
    }

    // 复制压缩包并提交
    const localCopy = path.join(process.cwd(), zipBaseName);
    fs.copyFileSync(localZipFile, localCopy);

    execSync(`git add -f "${zipBaseName}"`, { stdio: 'pipe' });
    try {
      console.log(`  git commit -m "deploy: ${buildVersion}"`);
      execSync(`git commit -m "deploy: ${buildVersion}"`, { stdio: 'inherit' });
    } catch (commitErr) {
      // 空提交（内容没变），跳过
      if (commitErr.message.includes('nothing to commit')) {
        console.log('  内容无变化，跳过提交');
      } else {
        throw commitErr;
      }
    }
    console.log(`  git push origin ${releaseBranch} ...`);
    execSync(`git push origin "${releaseBranch}"`, { stdio: 'inherit' });
    console.log(`✅ ${releaseBranch} 分支推送完成`);

    // ====== D. 切回原分支 ======
    // -f: release 是 orphan 分支，工作区还有源码文件，需强制覆盖
    execSync(`git checkout -f "${currentBranch}"`, { stdio: 'pipe' });
    // 清理本地残留文件
    try { if (fs.existsSync(localCopy)) fs.unlinkSync(localCopy); } catch { /* 忽略 */ }

    // ====== 恢复 stash（如果有） ======
    if (stashCreated) {
      try {
        console.log('  📦 恢复之前 stash 的未提交改动...');
        execSync('git stash pop', { stdio: 'inherit' });
        console.log('  ✅ stash 已恢复');
      } catch (e) {
        console.warn(`  ⚠️  stash 恢复失败（可能被部署残留文件冲突），请手动执行 git stash pop`);
        console.warn(`     stash 列表: 执行 git stash list 查看`);
      }
    }

    // ====== E. 服务器 Git 拉取 ======
    console.log(`\n[步骤 6/7] 服务器拉取构建产物（Git）...`);
    const serverGitDir = `${envConfig.backupDir}/git-release`;
    const serverGitDirEsc = shellEscape(serverGitDir);

    // 🔍 诊断日志：URL 来源
    const hasExplicitRemote = !!envConfig.gitRelease?.remote;
    console.log(`  📋 gitRelease.remote 配置: ${hasExplicitRemote ? envConfig.gitRelease.remote : '(未配置)'}`);
    console.log(`  📋 本地 origin URL: ${originUrl}`);
    if (hasExplicitRemote) {
      console.log(`  📋 使用配置的 remote → ${envConfig.gitRelease.remote}`);
    } else {
      console.log(`  📋 toSSHUrl 转换结果: ${originUrl} → ${toSSHUrl(originUrl)}`);
      console.log(`  📋 转换后协议: ${toSSHUrl(originUrl).startsWith('git@') ? 'SSH' : 'HTTPS（⚠️ 未识别平台，SSH key 不会生效）'}`);
    }

    const cloneUrl = envConfig.gitRelease?.remote || toSSHUrl(originUrl);
    console.log(`  📋 最终 clone URL: ${cloneUrl}`);

    // 检查服务器是否已有仓库（不仅要看 .git 目录，还要验证是有效的 git 仓库）
    let repoValid = false;
    try {
      const validCheck = await ssh.execCommand(
        `cd ${serverGitDirEsc} 2>/dev/null && git rev-parse --is-inside-work-tree 2>/dev/null`
      );
      repoValid = validCheck.includes('true');
    } catch {
      repoValid = false;
    }
    console.log(`  📋 服务器 Git 仓库状态: ${repoValid ? '有效 → 走 fetch 更新' : '无效/不存在 → 走 clone 初始化'}`);

    if (!repoValid) {
      console.log('  首次部署，服务器 clone 仓库...');
      console.log(`  📋 执行: cd ${serverGitDir} && git clone --depth 1 --single-branch --branch "${releaseBranch}" -- ${cloneUrl} .`);
      await ssh.execCommand(`mkdir -p ${serverGitDirEsc}`);
      try {
        await ssh.execCommand(
          `cd ${serverGitDirEsc} && git clone --depth 1 --single-branch --branch "${releaseBranch}" -- "${cloneUrl}" .`
        );
        console.log('  ✅ clone 成功');
      } catch (cloneErr) {
        console.error(`  ❌ clone 失败: ${cloneErr.message}`);
        // 打印服务器 SSH/密钥状态帮助排查
        try {
          const keys = await ssh.execCommand('ls -la ~/.ssh/ 2>/dev/null || echo "(无 .ssh 目录)"');
          console.log(`  📋 服务器 ~/.ssh 目录:\n${keys.trim()}`);
        } catch { /* 忽略 */ }
        try {
          const sshTest = await ssh.execCommand('ssh -o StrictHostKeyChecking=no -T git@github.com 2>&1 || true');
          console.log(`  📋 GitHub SSH 认证测试:\n${sshTest.trim()}`);
        } catch { /* 忽略 */ }
        throw cloneErr;
      }
    } else {
      console.log('  已有仓库，拉取更新...');
      try {
        await ssh.execCommand(
          `cd ${serverGitDirEsc} && git remote set-url origin "${cloneUrl}"`
        );
        console.log(`  ✅ remote set-url 完成 ( → ${cloneUrl} )`);
      } catch (remoteErr) {
        console.error(`  ❌ remote set-url 失败: ${remoteErr.message}`);
        throw remoteErr;
      }
      console.log(`  📋 执行: cd ${serverGitDir} && git fetch origin "${releaseBranch}" --depth 1`);
      try {
        await ssh.execCommand(
          `cd ${serverGitDirEsc} && git fetch origin "${releaseBranch}" --depth 1 && ` +
          `git checkout "${releaseBranch}" && git reset --hard "origin/${releaseBranch}"`
        );
        console.log('  ✅ fetch + checkout 完成');
      } catch (fetchErr) {
        console.error(`  ❌ fetch 失败: ${fetchErr.message}`);
        // 打印服务器当前状态帮助排查
        try {
          const remotes = await ssh.execCommand(`cd ${serverGitDirEsc} && git remote -v 2>/dev/null || echo "(无法获取)"`);
          console.log(`  📋 服务器 git remote:\n${remotes.trim()}`);
        } catch { /* 忽略 */ }
        try {
          const branches = await ssh.execCommand(`cd ${serverGitDirEsc} && git branch -a 2>/dev/null || echo "(无法获取)"`);
          console.log(`  📋 服务器 git branch -a:\n${branches.trim()}`);
        } catch { /* 忽略 */ }
        throw fetchErr;
      }
    }
    console.log('✅ 服务器拉取完成');

    // ====== F. 解压到临时目录 ======
    const protectedDirs = envConfig.protectedDirs || [];
    const tmpDeployDir = `${envConfig.backupDir}/deploy-git-tmp`;
    const tmpDirEsc = shellEscape(tmpDeployDir);
    const deployDirEsc = shellEscape(envConfig.deployDir);
    const zipBaseNameEsc = shellEscape(zipBaseName);

    await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);
    await ssh.execCommand(`mkdir -p ${deployDirEsc}`);
    await ssh.execCommand(
      `tar -xf ${serverGitDirEsc}/${zipBaseNameEsc} -C ${tmpDirEsc}`
    );
    console.log('✅ 解压完成');

    // ====== G. 原子替换 ======
    await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });
    console.log('✅ 部署目录已切换（零空窗期）');
    logger.logDeploy(envConfig.deployDir, true);

    // ====== H. 清理 ======
    try { if (fs.existsSync(localZipFile)) fs.unlinkSync(localZipFile); } catch { /* 忽略 */ }
    await ssh.execCommand(
      `cd ${serverGitDirEsc} && ls -t *.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f`
    );

  } catch (error) {
    // 尝试切回原分支
    if (currentBranch) {
      try { execSync(`git checkout -f "${currentBranch}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
    }
    // 尝试恢复 stash（即使出错也要恢复未提交的改动）
    if (stashCreated) {
      try {
        console.log('  📦 部署失败，恢复 stash 的未提交改动...');
        execSync('git stash pop', { stdio: 'inherit' });
        console.log('  ✅ stash 已恢复');
      } catch { /* stash 恢复失败时给出提示 */ }
    }
    // 清理本地文件
    try { if (fs.existsSync(localZipFile)) fs.unlinkSync(localZipFile); } catch { /* 忽略 */ }
    try { await ssh.execCommand(`rm -rf ${shellEscape(envConfig.backupDir + '/deploy-git-tmp')}`); } catch { /* 忽略 */ }

    logger.logDeploy(envConfig.deployDir, false);
    throw new Error(`Git 中转部署失败: ${error.message}`);
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
 * @param {boolean} options.enableBackupDownload - 是否启用备份下载
 */
export async function deployToServer(options) {
  const {
    environment,
    buildVersion,
    skipBuild = false, skipLocalCleanup = false,
    logger, localBackupDir, enableBackupDownload = true,
    transferMode: cliTransferMode  // CLI --transfer 参数
  } = options;

  // envConfig 可能被策略合并环境变量，因此从 options 动态读取
  let envConfig = options.envConfig;

  if (!skipBuild) {
    buildProject(envConfig, buildVersion, logger);
  }

  verifyBuildOutput(skipBuild, logger);

  const ssh = new SSHClient(envConfig);

  // ====== 确定传输策略顺序 ======
  // 优先级: CLI --transfer > 配置 transferMode > 自动检测
  const configuredMode = cliTransferMode || envConfig.transferMode || 'auto';

  // 检查是否配置了 Git Release
  const hasGitConfig = !!envConfig.gitRelease;

  /** @type {string[]} */
  let strategies = [];

  if (configuredMode === 'git') {
    strategies = ['git', 'sftp'];
    console.log('\n📌 传输模式: Git 中转部署（显式指定）');
  } else if (configuredMode === 'pipe') {
    strategies = ['pipe', 'sftp'];
    console.log('\n📌 传输模式: tar + gzip 管道流（显式指定）');
  } else if (configuredMode === 'sftp') {
    strategies = ['sftp'];
    console.log('\n📌 传输模式: SFTP 上传');
  } else {
    // 自动: git > sftp
    if (hasGitConfig) {
      strategies = ['git', 'sftp'];
      console.log('\n📌 检测到 Git Release 配置，优先使用 Git 中转部署');
    } else {
      strategies = ['sftp'];
      console.log('\n📌 使用 SFTP 上传模式（稳定可靠）');
    }
  }

  let finalMode = null;
  let backupDone = false; // 跟踪备份是否已完成，降级时避免重复备份

  try {
    await ssh.connect();
    logger.logSSHConnect(envConfig.sshHost, true);

    for (const strategy of strategies) {
      if (strategy === 'git') {
        try {
          await gitUploadDeploy({ ssh, envConfig, buildVersion, logger, skipBackup: backupDone });
          finalMode = 'git';
          break;
        } catch (gitError) {
          backupDone = true;
          console.log(`\n⚠️  Git 中转失败 (${gitError.message})，降级...`);
          logger.log('WARN', '传输降级', `Git 失败: ${gitError.message}`);
          try { await ssh.execCommand(`rm -rf ${shellEscape(envConfig.backupDir + '/deploy-git-tmp')}`); } catch { /* 忽略 */ }
          continue;
        }
      }

      if (strategy === 'pipe') {
        try {
          await pipeUploadDeploy({ ssh, envConfig, buildVersion, logger, skipBackup: backupDone });
          finalMode = 'pipe';
          break;
        } catch (pipeError) {
          backupDone = true;
          console.log(`\n⚠️  管道流失败 (${pipeError.message})，降级...`);
          logger.log('WARN', '传输降级', `管道流失败: ${pipeError.message}`);
          try { await ssh.execCommand(`rm -rf ${shellEscape(envConfig.backupDir + '/deploy-tmp')}`); } catch { /* 忽略 */ }
          continue;
        }
      }

      if (strategy === 'sftp') {
        // ====== SFTP 上传（兜底）======
        const localZipFile = `dist-${buildVersion}.tar.gz`;
        const remoteZipFile = `${envConfig.backupDir}/${localZipFile}`;

        await compressBuild(localZipFile, logger);
        // 只有前面的策略未备份时才备份，避免重复
        if (!backupDone) {
          await backupExistingDeployment({ ssh, envConfig, buildVersion, logger, suffix: '-sftp' });
        } else {
          console.log('  (跳过备份，前面策略已创建)');
        }
        await uploadBuild({ ssh, localZipFile, remoteZipFile, logger });

        try {
          await deployAndExtract({ ssh, envConfig, remoteZipFile, logger });
        } catch (error) {
          console.error('❌ 清理或解压失败!');
          await ssh.disconnect();
          throw error;
        }

        try {
          await cleanupFiles({ ssh, remoteZipFile, localZipFile, skipLocalCleanup, logger });
        } catch {
          console.warn('⚠️  删除压缩包失败,但不影响部署');
        }
        finalMode = 'sftp';
        break;
      }
    }

    if (!finalMode) {
      throw new Error('所有传输模式均失败');
    }

    // 下载线上备份到本地（Git 模式下跳过，备份已在远端）
    if (enableBackupDownload && localBackupDir && finalMode !== 'git') {
      await downloadBackup({ ssh, envConfig, buildVersion, localBackupDir, logger });
    } else if (finalMode === 'git') {
      console.log('\n📌 Git 模式：构建产物已存储在 Git Release 仓库，跳过本地下载');
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
    const modeNames = {
      git: 'Git 中转部署',
      pipe: 'tar + gzip 管道流直传',
      sftp: 'SFTP 上传'
    };
    console.log(`传输模式: ${modeNames[finalMode] || finalMode}`);
    console.log('========================================');

    logger.log('SUCCESS', '部署完成', `环境: ${environment}, 版本: ${buildVersion}, 传输: ${finalMode}`);
  } catch (error) {
    console.error('部署失败:', error);
    logger.log('ERROR', '部署失败', error.message);
    // 确保 SSH 连接关闭（带超时保护）
    try {
      await ssh.disconnect();
    } catch {
      // 强制销毁连接
      try { ssh.client.destroy(); } catch { /* 最终兜底 */ }
    }
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
        const listCommand = `ls -t ${shellEscape(envConfig.backupDir)}/${shellEscape(envConfig.backupPrefix)}*.tar.gz 2>/dev/null | head -n 1`;
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
    const checkCommand = `test -f ${shellEscape(finalBackupFile)} && echo 'FILE_YES' || echo 'FILE_NO'`;
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
    const deployDirEsc = shellEscape(envConfig.deployDir);
    const backupFileEsc = shellEscape(finalBackupFile);

    console.log('\n[步骤 3/4] 执行回滚...');

    try {
      await ssh.execCommand(`mkdir -p ${deployDirEsc}`);

      if (protectedDirs.length > 0) {
        console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
        const excludeArgs = protectedDirs.map(d => `! -name ${shellEscape(d)}`).join(' ');
        await ssh.execCommand(
          `find ${deployDirEsc} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
        );
        console.log('✅ 已清理非保护目录的文件');
      } else {
        await ssh.execCommand(`rm -rf ${deployDirEsc}/*`);
      }

      if (protectedDirs.length > 0) {
        const excludeArgs = protectedDirs.map(d => `--exclude=${shellEscape('./' + d)}`).join(' ');
        await ssh.execCommand(`tar -xf ${backupFileEsc} ${excludeArgs} -C ${deployDirEsc}`);
      } else {
        await ssh.execCommand(`tar -xf ${backupFileEsc} -C ${deployDirEsc}`);
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
      const verifyResult = await ssh.execCommand(`ls -la ${deployDirEsc} | head -n 20`);
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
        // 强制销毁连接
        try { ssh.client.destroy(); } catch { /* 最终兜底 */ }
      }
    }
    throw error;
  }
}

export default {
  gitUploadDeploy,
  buildProject,
  verifyBuildOutput,
  compressBuild,
  backupExistingDeployment,
  uploadBuild,
  deployAndExtract,
  cleanupFiles,
  downloadBackup,
  deployToServer,
  rollbackDeployment,
  getServerBackupList,
  getLocalBackupList,
  rollbackFromLocal
};
