import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import SSHClient from './ssh-client.js';
import { OBSClient } from './obs-client.js';
import { DeployLogger, cleanLocalBackups } from './logger.js';
import { formatBytes, shellEscape, parseBackupFilename, expandTilde, isWindows } from './utils.js';

/**
 * 解析 OBS 配置，用环境变量补齐缺失的敏感字段
 *
 * 支持的环境变量:
 *   FE_BUILD_OBS_ACCESS_KEY_ID     — OBS Access Key ID
 *   FE_BUILD_OBS_SECRET_ACCESS_KEY — OBS Secret Access Key
 *
 * 使用场景: fe-build.config.js 中只配置非敏感的 bucket/endpoint，
 * AK/SK 通过环境变量注入，避免敏感信息提交到 Git。
 *
 * @param {object|undefined} obsConfig - 配置文件中的 obsConfig
 * @returns {object|null} 合并后的完整 OBS 配置，或 null
 */
export function resolveOBSConfig(obsConfig) {
  if (!obsConfig || !obsConfig.bucket) {
    // 如果完全没有 obsConfig 但环境变量中有关键信息，也尝试构建
    const envBucket = process.env.FE_BUILD_OBS_BUCKET;
    const envEndpoint = process.env.FE_BUILD_OBS_ENDPOINT;
    if (!envBucket && !envEndpoint) return null;

    return {
      bucket: envBucket || '',
      endpoint: envEndpoint || '',
      internalEndpoint: process.env.FE_BUILD_OBS_INTERNAL_ENDPOINT || envEndpoint || '',
      accessKeyId: process.env.FE_BUILD_OBS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.FE_BUILD_OBS_SECRET_ACCESS_KEY || '',
      uploadDir: process.env.FE_BUILD_OBS_UPLOAD_DIR || ''
    };
  }

  // 以配置文件为主，环境变量兜底补齐 AK/SK
  return {
    ...obsConfig,
    accessKeyId: obsConfig.accessKeyId || process.env.FE_BUILD_OBS_ACCESS_KEY_ID || '',
    secretAccessKey: obsConfig.secretAccessKey || process.env.FE_BUILD_OBS_SECRET_ACCESS_KEY || ''
  };
}

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
 * 使用 rsync over SSH 增量同步部署
 *
 * 流程:
 *   1. 备份现有部署（复用 backupExistingDeployment）
 *   2. 创建远程临时目录 backupDir/deploy-rsync-tmp
 *   3. rsync dist/ → 远程临时目录（增量同步，只传差异文件）
 *   4. 原子交换 swapDeployDir() → deployDir
 *
 * rsync 通过 spawn 独立进程运行，自行管理 SSH 连接（RSYNC_RSH 环境变量）。
 * 原有的 SSHClient 连接仍用于备份、目录准备和原子交换。
 *
 * @param {object} options
 * @param {SSHClient} options.ssh
 * @param {object} options.envConfig
 * @param {string} options.buildVersion
 * @param {DeployLogger} options.logger
 */
export async function rsyncUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, logger, skipBackup = false } = options;

  // ====== A. 备份当前部署 ======
  if (!skipBackup) {
    await backupExistingDeployment({ ssh, envConfig, buildVersion, logger });
  } else {
    console.log('  (跳过备份，前面策略已创建)');
  }

  // ====== B. 准备临时目录 ======
  console.log('\n[步骤 3/7] 准备临时部署目录...');

  const protectedDirs = envConfig.protectedDirs || [];
  const tmpDeployDir = `${envConfig.backupDir}/deploy-rsync-tmp`;
  const tmpDirEsc = shellEscape(tmpDeployDir);
  const deployDirEsc = shellEscape(envConfig.deployDir);

  await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);
  await ssh.execCommand(`mkdir -p ${deployDirEsc}`);
  console.log('✅ 临时部署目录已就绪');

  // ====== C. rsync 增量同步 ======
  console.log(`\n[步骤 4/7] rsync 增量同步 dist/ → ${envConfig.sshHost}...`);
  console.log('  (rsync: 仅传输变更文件，重试 1 次 + 超时保护)');

  const keyPath = expandTilde(envConfig.sshKeyPath).replace(/\\/g, '/');
  const sshPort = envConfig.sshPort || 22;
  const remoteTarget = `${envConfig.sshUser}@${envConfig.sshHost}:${tmpDeployDir}`;

  // 构建 SSH 命令（作为 rsync -e 的参数）
  // -q + LogLevel=QUIET 强制静默所有 SSH 输出，防止 MOTD/banner/.bashrc 混入 rsync 协议流
  const sshCmd = `ssh -q -i ${keyPath} -p ${sshPort} -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o BatchMode=yes -o LogLevel=QUIET`;

  const rsyncArgs = [
    '-az',                  // 归档 + 压缩
    '--delete',             // 删除远程多余文件
    '--no-perms',
    '--no-owner',
    '--no-group',
    '--info=progress2',     // 总进度（非每文件）
    '--human-readable',
    '--timeout=120',        // rsync 内置超时：120s 无传输则退出
    '-e', sshCmd,           // SSH 命令（数组方式避免引用嵌套）
    './dist/',              // 注意尾部 / = 复制内容而非目录本身
    `${remoteTarget}/`
  ];

  // 排除受保护目录
  for (const dir of protectedDirs) {
    rsyncArgs.push('--exclude', dir);
  }

  /**
   * 执行一次 rsync 同步
   * @returns {Promise<number>} 耗时（秒）
   */
  const runRsyncOnce = () => new Promise((resolve, reject) => {
    const startTime = Date.now();
    let rsyncProc = null;

    // 总超时定时器：5 分钟无结果强制 kill（rsync --timeout 只管 I/O 超时）
    const hardTimeout = setTimeout(() => {
      if (rsyncProc && !rsyncProc.killed) {
        try { rsyncProc.kill('SIGTERM'); } catch { /* 忽略 */ }
      }
    }, 300000); // 5 分钟硬超时

    try {
      // Windows 上 rsync 是 MSYS2/Git Bash 程序，必须通过 shell 调用才能正确初始化
      rsyncProc = spawn('rsync', rsyncArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindows()
      });
    } catch (err) {
      clearTimeout(hardTimeout);
      reject(err);
      return;
    }

    let lastProgress = Date.now();

    // 解析 --info=progress2 输出
    const progressRegex = /^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[A-Za-z\/]+)\s/;

    rsyncProc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const match = line.match(progressRegex);
        if (match) {
          const now = Date.now();
          if (now - lastProgress > 200) {
            lastProgress = now;
            const bytes = parseInt(match[1].replace(/,/g, ''), 10);
            const pct = parseInt(match[2], 10);
            const speed = match[3];
            const barW = 20;
            const filled = Math.round((pct / 100) * barW);
            const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
            const elapsed = (now - startTime) / 1000;
            process.stdout.write(
              `\rrsync [${bar}] ${pct}%  ${formatBytes(bytes)}  ${speed}  ${elapsed.toFixed(0)}s`
            );
          }
        }
      }
    });

    let stderrBuf = '';
    rsyncProc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    rsyncProc.on('error', (err) => {
      clearTimeout(hardTimeout);
      reject(err);
    });

    rsyncProc.on('close', (code) => {
      clearTimeout(hardTimeout);
      const duration = Math.round((Date.now() - startTime) / 1000);
      if (code === 0) {
        resolve(duration);
      } else {
        const errDetail = stderrBuf.trim() ? ` — ${stderrBuf.trim().split('\n').pop()}` : '';
        reject(new Error(`rsync 退出码: ${code}${errDetail}`));
      }
    });
  });

  // 重试循环（最多 2 次）
  let lastError = null;
  let rsyncSuccess = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      console.log(`\n🔄 rsync 重试 (${attempt}/2)...`);
      // 重试前等待 2 秒
      await new Promise(r => setTimeout(r, 2000));
    }

    try {
      const duration = await runRsyncOnce();
      process.stdout.write(`\r✅ rsync 同步完成 (${duration}s)                    \n`);
      logger.logUpload('dist/', tmpDeployDir, 0, duration, true);
      rsyncSuccess = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.error(`\n⚠️  rsync 失败 (${error.message})，准备重试...`);
      }
    }
  }

  if (!rsyncSuccess) {
    logger.logUpload('dist/', tmpDeployDir, 0, 0, false);

    console.error('\n❌ rsync 传输失败，清理临时目录...');
    try { await ssh.execCommand(`rm -rf ${tmpDirEsc}`); } catch { /* 忽略 */ }

    // 尝试还原备份
    const latestBackup = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
    console.error('尝试还原备份...');
    try {
      await ssh.execCommand(`tar -xf ${shellEscape(latestBackup)} -C ${deployDirEsc}`);
      console.log('✅ 已还原备份');
    } catch {
      console.error('⚠️  还原备份也失败了，请手动检查');
    }
    throw new Error(`rsync 传输失败: ${lastError.message}`);
  }

  // ====== D. 原子交换 ======
  console.log('\n[步骤 5/7] 原子替换部署目录...');
  await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });
  console.log('✅ 部署目录已切换（零空窗期）');
  logger.logDeploy(envConfig.deployDir, true);
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
 * 检测本地是否安装了 rsync 二进制文件
 * @returns {boolean}
 */
export function checkRsyncAvailable() {
  try {
    execSync('rsync --version', { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

// ====== OBS 中转部署（华为云对象存储） ======

/**
 * OBS 模式备份现有部署
 * 服务器 tar+gzip 压缩 → curl PUT 上传到 OBS（内网）→ 清理服务器临时文件
 * @param {object} options
 */
async function backupToOBS(options) {
  const { ssh, envConfig, buildVersion, obsClient, logger } = options;
  console.log('\n[步骤 4/7] 备份现有部署到 OBS...');

  const backupFilename = `${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
  const remoteTempDir = `${envConfig.backupDir}/.obs-backup-tmp`;
  const remoteTempFile = `${remoteTempDir}/${backupFilename}`;
  const remoteTempDirEsc = shellEscape(remoteTempDir);
  const remoteTempFileEsc = shellEscape(remoteTempFile);
  const deployDirEsc = shellEscape(envConfig.deployDir);

  // 检查部署目录是否有文件
  const checkResult = await ssh.execCommand(
    `[ -d ${deployDirEsc} ] && [ "$(ls -A ${deployDirEsc} 2>/dev/null)" ] && echo 'has_files' || echo 'empty'`
  );

  if (!checkResult.includes('has_files')) {
    logger.log('INFO', 'OBS 备份', '部署目录为空或不存在，跳过备份');
    console.log('部署目录为空或不存在，跳过 OBS 备份');
    return;
  }

  try {
    // 1. 创建临时目录并在服务器上压缩现有部署
    console.log('  压缩现有部署（服务器端 tar+gzip）...');
    await ssh.execCommand(`mkdir -p ${remoteTempDirEsc}`);
    const protectedDirs = envConfig.protectedDirs || [];
    const excludeArgs = protectedDirs.map(d => `--exclude=${shellEscape('./' + d)}`).join(' ');
    const tarCmd = protectedDirs.length > 0
      ? `tar -czf ${remoteTempFileEsc} ${excludeArgs} -C ${deployDirEsc} .`
      : `tar -czf ${remoteTempFileEsc} -C ${deployDirEsc} .`;
    await ssh.execCommand(tarCmd);
    console.log('✅ 服务器端压缩完成');

    // 2. 生成 OBS 预签名上传 URL（使用内网 endpoint）
    console.log('  生成 OBS 预签名上传 URL（内网）...');
    const presignedUploadUrl = obsClient.getSignedUrl(backupFilename, 3600, 'PUT', true);

    // 3. SSH 服务器用 curl 上传备份到 OBS（内网）
    console.log('  服务器上传备份到 OBS（内网）...');
    const startTime = Date.now();
    await ssh.execCommand(
      `curl -s -X PUT -T ${remoteTempFileEsc} "${presignedUploadUrl}"`
    );
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ OBS 备份上传完成 (${duration}s)`);

    logger.logBackup(`obs://${obsClient.bucket}/${backupFilename}`, true);

    // 4. 清理服务器临时文件
    await ssh.execCommand(`rm -rf ${remoteTempDirEsc}`);

    // 5. 按保留策略清理 OBS 旧备份
    const retentionCount = envConfig.backupRetentionCount || 1;
    await cleanOldOBSBackups(obsClient, envConfig.backupPrefix, retentionCount, logger);

  } catch (error) {
    // 清理服务器临时文件
    try { await ssh.execCommand(`rm -rf ${remoteTempDirEsc}`); } catch { /* 忽略 */ }
    logger.logBackup(`obs://${obsClient.bucket}/${backupFilename}`, false);
    console.warn(`⚠️  OBS 备份上传失败: ${error.message}`);
    // 备份失败不阻断部署主流程
  }
}

/**
 * 清理 OBS 上旧的备份文件，保留最新 N 个
 * @param {OBSClient} obsClient
 * @param {string} prefix - 备份前缀
 * @param {number} retentionCount - 保留数量
 * @param {DeployLogger} logger
 */
async function cleanOldOBSBackups(obsClient, prefix, retentionCount, logger) {
  try {
    const objects = await obsClient.listObjects(prefix);
    if (objects.length <= retentionCount) return;

    // 按 lastModified 降序排列，删除多余的
    objects.sort((a, b) => b.lastModified - a.lastModified);
    const toDelete = objects.slice(retentionCount);

    for (const obj of toDelete) {
      // 从完整 key 中移除 uploadDir 前缀，获取相对 key
      const relKey = obsClient.uploadDir
        ? obj.key.substring(obsClient.uploadDir.length + 1)
        : obj.key;
      await obsClient.deleteObject(relKey);
      console.log(`  🗑️ 删除旧 OBS 备份: ${obj.key}`);
    }
    if (toDelete.length > 0) {
      console.log(`✅ OBS 旧备份清理完成（删除 ${toDelete.length} 个，保留 ${retentionCount} 个）`);
      logger.log('INFO', 'OBS 备份清理', `删除了 ${toDelete.length} 个旧备份`);
    }
  } catch (error) {
    console.warn('⚠️ OBS 旧备份清理失败:', error.message);
  }
}

/**
 * SSH 到服务器从 OBS 下载构建产物并部署
 * @param {object} options
 */
async function obsServerDeploy(options) {
  const { ssh, envConfig, downloadUrl, logger } = options;
  console.log('\n[步骤 6/7] 服务器从 OBS 内网拉取构建产物...');

  const protectedDirs = envConfig.protectedDirs || [];
  const tmpDeployDir = `${envConfig.backupDir}/deploy-obs-tmp`;
  const tmpDirEsc = shellEscape(tmpDeployDir);
  const deployDirEsc = shellEscape(envConfig.deployDir);
  const remoteZipPath = `${tmpDeployDir}/build.tar.gz`;
  const remoteZipEsc = shellEscape(remoteZipPath);

  // 准备临时目录
  await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);
  await ssh.execCommand(`mkdir -p ${deployDirEsc}`);
  console.log('✅ 临时部署目录已就绪');

  const startTime = Date.now();

  try {
    // 服务器 curl 下载（内网）
    console.log('  服务器下载中（curl）...');
    await ssh.execCommand(`curl -sL -o ${remoteZipEsc} "${downloadUrl}"`);
    const downloadDuration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ OBS 拉取完成 (${downloadDuration}s)`);
    logger.logUpload('OBS', envConfig.deployDir, 0, downloadDuration, true);

    // 解压到临时目录
    console.log('\n[步骤 7/7] 解压构建产物 + 原子替换...');
    await ssh.execCommand(`tar -xf ${remoteZipEsc} -C ${tmpDirEsc}`);
    console.log('✅ 解压完成');

    // 删除远程压缩包
    await ssh.execCommand(`rm -f ${remoteZipEsc}`);

    // 原子替换
    await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });
    console.log('✅ 部署目录已切换（零空窗期）');
    logger.logDeploy(envConfig.deployDir, true);

  } catch (error) {
    // 清理远程临时目录
    try { await ssh.execCommand(`rm -rf ${tmpDirEsc}`); } catch { /* 忽略 */ }
    throw new Error(`OBS 服务器部署失败: ${error.message}`);
  }
}

/**
 * OBS 中转部署模式（主函数）
 *
 * 流程:
 *   1. 备份现有部署到 OBS
 *   2. 压缩本地构建产物
 *   3. 上传压缩包到 OBS（公网）
 *   4. 生成预签名下载 URL（内网）
 *   5. SSH 服务器 curl 下载（内网）→ 解压 → 原子替换
 *   6. 清理本地压缩包
 *
 * @param {object} options
 */
export async function obsUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, logger, skipBackup = false } = options;

  const obsClient = new OBSClient(envConfig.obsConfig);
  const obsObjectKey = `${envConfig.backupPrefix}-${buildVersion}.tar.gz`;
  const localZipFile = `dist-${buildVersion}.tar.gz`;

  try {
    // ====== A. 备份现有部署到 OBS ======
    if (!skipBackup) {
      await backupToOBS({ ssh, envConfig, buildVersion, obsClient, logger });
    } else {
      console.log('  (跳过备份，前面策略已创建)');
    }

    // ====== B. 压缩本地构建产物 ======
    await compressBuild(localZipFile, logger);

    // ====== C. 上传压缩包到 OBS（公网） ======
    console.log('\n[步骤 5/7] 上传构建产物到 OBS...');
    const obsResult = await obsClient.uploadFile(localZipFile, obsObjectKey);
    const stats = fs.statSync(localZipFile);
    logger.logOBS('上传', obsResult.bucket, obsResult.key, true);

    // ====== D. 生成预签名下载 URL（使用内网 endpoint） ======
    const downloadUrl = obsClient.getSignedUrl(obsObjectKey, 3600, 'GET', true);

    // ====== E. SSH 到服务器 → curl 下载 → 解压 → 原子替换 ======
    await obsServerDeploy({ ssh, envConfig, downloadUrl, logger });

    // ====== F. 清理本地压缩包 ======
    try {
      fs.unlinkSync(localZipFile);
      console.log('✅ 本地压缩包已删除');
    } catch (e) {
      console.warn('⚠️ 本地压缩包删除失败:', e.message);
    }

  } catch (error) {
    // 清理本地压缩包（保留下载给降级策略使用）
    try { if (fs.existsSync(localZipFile)) fs.unlinkSync(localZipFile); } catch { /* 忽略 */ }
    logger.logDeploy(envConfig.deployDir, false);
    throw error;
  }
}

/**
 * 获取 OBS 上的备份列表（用于回滚）
 * @param {object} envConfig - 环境配置（含 obsConfig）
 * @returns {Promise<Array>}
 */
export async function getOBSBackupList(envConfig) {
  const obsConfig = resolveOBSConfig(envConfig.obsConfig);
  if (!obsConfig) return [];

  try {
    const obsClient = new OBSClient(obsConfig);
    const objects = await obsClient.listObjects(envConfig.backupPrefix);

    return objects.map(obj => {
      const filename = obsClient.uploadDir
        ? obj.key.substring(obsClient.uploadDir.length + 1)
        : obj.key;
      const parsed = parseBackupFilename(filename);
      return {
        file: obj.key,
        filename,
        prefix: parsed?.prefix,
        version: parsed?.version || filename.replace(/\.tar\.gz$/, ''),
        mtime: obj.lastModified,
        size: obj.size,
        isServer: false,
        isOBS: true
      };
    });
  } catch (error) {
    console.warn('⚠️ 获取 OBS 备份列表失败:', error.message);
    return [];
  }
}

// ====== Git 中转部署（通过独立的 Git Release 仓库） ======

/**
 * Git 中转部署模式
 *
 * 流程:
 *   1. 备份现有部署
 *   2. 压缩本地构建产物 → dist-{version}.tar.gz
 *   3. 推送到独立 Git Release 仓库（含 version tag）
 *   4. SSH 服务器 git pull → 解压 → 原子替换
 *   5. 清理本地和远程临时文件
 *
 * @param {object} options
 */
export async function gitUploadDeploy(options) {
  const { ssh, envConfig, buildVersion, logger, skipBackup = false } = options;
  const { repo, branch = 'main' } = envConfig.gitRelease || {};

  if (!repo) {
    throw new Error('gitRelease.repo 未配置');
  }

  // ====== A. 备份当前部署 ======
  if (!skipBackup) {
    await backupExistingDeployment({ ssh, envConfig, buildVersion, logger });
  } else {
    console.log('  (跳过备份，前面策略已创建)');
  }

  // ====== B. 压缩构建产物 ======
  const localZipFile = `dist-${buildVersion}.tar.gz`;
  await compressBuild(localZipFile, logger);

  // ====== C. 本地 Git 推送 ======
  console.log(`\n[步骤 5/7] 推送构建产物到 Git Release 仓库...`);
  console.log(`  ${repo}`);

  const tagName = buildVersion;
  const zipBaseName = path.basename(localZipFile);
  const tmpGitDir = path.join(os.tmpdir(), `fe-build-git-${buildVersion}-${Date.now()}`);

  try {
    // Clone release 仓库（浅克隆）
    try {
      execSync(`git clone --depth 1 --branch "${branch}" -- "${repo}" "${tmpGitDir}"`, {
        stdio: 'pipe', timeout: 60000
      });
    } catch (cloneError) {
      // 仓库为空或分支不存在，init + remote
      console.log('  仓库可能为空或分支不存在，尝试初始化...');
      fs.mkdirSync(tmpGitDir, { recursive: true });
      execSync(`git init`, { cwd: tmpGitDir, stdio: 'pipe' });
      execSync(`git remote add origin "${repo}"`, { cwd: tmpGitDir, stdio: 'pipe' });
      try {
        execSync(`git checkout -b "${branch}"`, { cwd: tmpGitDir, stdio: 'pipe' });
      } catch { /* 分支可能已存在 */ }
    }

    // 复制压缩包到仓库
    fs.copyFileSync(localZipFile, path.join(tmpGitDir, zipBaseName));

    // git add + commit + tag + push
    execSync(`git add -A`, { cwd: tmpGitDir, stdio: 'pipe' });
    execSync(`git commit -m "deploy: ${buildVersion}"`, { cwd: tmpGitDir, stdio: 'pipe' });
    execSync(`git tag -f "${tagName}"`, { cwd: tmpGitDir, stdio: 'pipe' });
    execSync(`git push origin "${branch}" --tags`, { cwd: tmpGitDir, stdio: 'pipe' });
    console.log(`✅ Git 推送完成 (tag: ${tagName})`);

    // ====== D. 服务器 Git 拉取 ======
    console.log(`\n[步骤 6/7] 服务器拉取构建产物（Git）...`);
    const serverGitDir = `${envConfig.backupDir}/git-release`;
    const serverGitDirEsc = shellEscape(serverGitDir);
    const zipBaseNameEsc = shellEscape(zipBaseName);

    // 检查服务器是否已有仓库
    const checkResult = await ssh.execCommand(
      `test -d ${serverGitDirEsc}/.git && echo 'EXISTS' || echo 'NOT_FOUND'`
    );

    if (checkResult.includes('NOT_FOUND')) {
      console.log('  首次部署，初始化服务器 Git 仓库...');
      await ssh.execCommand(`mkdir -p ${serverGitDirEsc}`);
      try {
        await ssh.execCommand(
          `cd ${serverGitDirEsc} && git clone --depth 1 --branch "${branch}" -- "${repo}" .`
        );
      } catch {
        // 空仓库 fallback
        await ssh.execCommand(
          `cd ${serverGitDirEsc} && git init && git remote add origin "${repo}"`
        );
        try {
          await ssh.execCommand(`cd ${serverGitDirEsc} && git checkout -b "${branch}"`);
        } catch { /* ignore */ }
      }
    }

    // Fetch + checkout 指定 tag
    await ssh.execCommand(
      `cd ${serverGitDirEsc} && git fetch origin --tags && git checkout "${tagName}"`
    );
    console.log(`✅ 服务器拉取完成`);

    // ====== E. 解压到临时目录 ======
    const protectedDirs = envConfig.protectedDirs || [];
    const tmpDeployDir = `${envConfig.backupDir}/deploy-git-tmp`;
    const tmpDirEsc = shellEscape(tmpDeployDir);
    const deployDirEsc = shellEscape(envConfig.deployDir);

    await ssh.execCommand(`rm -rf ${tmpDirEsc} && mkdir -p ${tmpDirEsc}`);
    await ssh.execCommand(`mkdir -p ${deployDirEsc}`);
    await ssh.execCommand(
      `tar -xf ${serverGitDirEsc}/${zipBaseNameEsc} -C ${tmpDirEsc}`
    );
    console.log('✅ 解压完成');

    // ====== F. 原子替换 ======
    await swapDeployDir({ ssh, envConfig, tmpDeployDir, protectedDirs });
    console.log('✅ 部署目录已切换（零空窗期）');
    logger.logDeploy(envConfig.deployDir, true);

    // ====== G. 清理 ======
    try { if (fs.existsSync(localZipFile)) fs.unlinkSync(localZipFile); } catch { /* 忽略 */ }
    try { fs.rmSync(tmpGitDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    // 服务器只保留最新一个压缩包
    await ssh.execCommand(
      `cd ${serverGitDirEsc} && ls -t *.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f`
    );

  } catch (error) {
    // 清理
    try { if (fs.existsSync(localZipFile)) fs.unlinkSync(localZipFile); } catch { /* 忽略 */ }
    try { fs.rmSync(tmpGitDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
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

  // envConfig 可能在 OBS 策略中被合并环境变量，因此从 options 动态读取
  let envConfig = options.envConfig;

  if (!skipBuild) {
    buildProject(envConfig, buildVersion, logger);
  }

  verifyBuildOutput(skipBuild, logger);

  const ssh = new SSHClient(envConfig);

  // ====== 确定传输策略顺序 ======
  // 优先级: CLI --transfer > 配置 transferMode > 自动检测
  const configuredMode = cliTransferMode || envConfig.transferMode || 'auto';

  // 检查是否配置了 OBS（配置文件 + 环境变量合并）
  const resolvedOBSConfig = resolveOBSConfig(envConfig.obsConfig);
  const hasOBSConfig = !!(resolvedOBSConfig && resolvedOBSConfig.bucket);
  if (resolvedOBSConfig) {
    envConfig = { ...envConfig, obsConfig: resolvedOBSConfig };
  }

  // 检查是否配置了 Git Release
  const hasGitConfig = !!(envConfig.gitRelease && envConfig.gitRelease.repo);

  /** @type {string[]} */
  let strategies = [];

  if (configuredMode === 'git') {
    strategies = ['git', 'rsync', 'sftp'];
    console.log('\n📌 传输模式: Git 中转部署（显式指定）');
  } else if (configuredMode === 'obs') {
    strategies = ['obs', 'rsync', 'sftp'];
    console.log('\n📌 传输模式: OBS 中转部署（显式指定）');
  } else if (configuredMode === 'pipe') {
    strategies = ['pipe', 'sftp'];
    console.log('\n📌 传输模式: tar + gzip 管道流（显式指定）');
  } else if (configuredMode === 'rsync') {
    strategies = ['rsync', 'sftp'];
    console.log('\n📌 传输模式: rsync 增量同步');
  } else if (configuredMode === 'sftp') {
    strategies = ['sftp'];
    console.log('\n📌 传输模式: SFTP 上传');
  } else {
    // 自动: git > rsync > sftp
    if (hasGitConfig) {
      strategies = ['git', 'rsync', 'sftp'];
      console.log('\n📌 检测到 Git Release 配置，优先使用 Git 中转部署');
    } else if (checkRsyncAvailable()) {
      strategies = ['rsync', 'sftp'];
      console.log('\n📌 本地 rsync 可用，优先使用 rsync 增量同步');
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

      if (strategy === 'obs') {
        try {
          await obsUploadDeploy({ ssh, envConfig, buildVersion, logger, skipBackup: backupDone });
          finalMode = 'obs';
          break;
        } catch (obsError) {
          backupDone = true;
          console.log(`\n⚠️  OBS 中转失败 (${obsError.message})，降级...`);
          logger.log('WARN', '传输降级', `OBS 失败: ${obsError.message}`);
          try { await ssh.execCommand(`rm -rf ${shellEscape(envConfig.backupDir + '/deploy-obs-tmp')}`); } catch { /* 忽略 */ }
          continue;
        }
      }

      if (strategy === 'rsync') {
        try {
          // 检查远程 rsync 是否可用
          const remoteCheck = await ssh.execCommand(
            'command -v rsync 2>/dev/null && echo "AVAILABLE" || echo "NOT_FOUND"'
          );
          if (remoteCheck.includes('NOT_FOUND')) {
            console.log('\n⚠️  服务器未安装 rsync，跳过');
            logger.log('WARN', '传输降级', '服务器未安装 rsync');
            continue;
          }
          await rsyncUploadDeploy({ ssh, envConfig, buildVersion, logger, skipBackup: backupDone });
          finalMode = 'rsync';
          break;
        } catch (rsyncError) {
          backupDone = true;
          console.log(`\n⚠️  rsync 失败 (${rsyncError.message})，降级...`);
          logger.log('WARN', '传输降级', `rsync 失败: ${rsyncError.message}`);
          try { await ssh.execCommand(`rm -rf ${shellEscape(envConfig.backupDir + '/deploy-rsync-tmp')}`); } catch { /* 忽略 */ }
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

    // 下载线上备份到本地（OBS/Git 模式下跳过，备份已在远端）
    if (enableBackupDownload && localBackupDir && finalMode !== 'obs' && finalMode !== 'git') {
      await downloadBackup({ ssh, envConfig, buildVersion, localBackupDir, logger });
    } else if (finalMode === 'obs') {
      console.log('\n📌 OBS 模式：备份已存储在 OBS，跳过本地下载');
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
      obs: 'OBS 中转部署',
      rsync: 'rsync 增量同步',
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
  pipeUploadDeploy,
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
