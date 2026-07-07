/**
 * 部署前环境预检模块
 *
 * 在部署前检查本地和远程环境，确保部署可以顺利进行。
 * 检查结果分为三级：
 *   ✅ pass  — 通过
 *   ⚠️ warn  — 警告（不阻断部署）
 *   ❌ fail  — 阻断（必须修复后才能部署）
 */

import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import SSHClient from './ssh-client.js';
import { checkUncommittedChanges, getCurrentBranch } from './git-branch.js';

/**
 * @typedef {object} CheckResult
 * @property {string} name   - 检查项名称
 * @property {'pass'|'warn'|'fail'} status - 检查状态
 * @property {string} message - 检查结果描述
 * @property {string} [detail] - 详细信息
 */

/**
 * 运行完整预检
 * @param {object} options
 * @param {string} options.environment - 环境名称
 * @param {object} options.envConfig   - 环境配置
 * @param {object} [options.config]    - 完整配置（可选，用于配置校验）
 * @param {boolean} [options.quick]    - 快速模式，跳过耗时检查
 * @returns {Promise<{results: CheckResult[], canDeploy: boolean}>}
 */
export async function runPreflightChecks(options) {
  const { environment, envConfig, config, quick = false } = options;

  const results = [];

  // ====== 配置校验 ======
  if (config) {
    results.push(...validateServerConfig(envConfig, environment));
  }

  // ====== 本地环境检查 ======
  results.push(checkNodeVersion());
  results.push(checkGitAvailable());
  results.push(checkGitStatus());
  results.push(checkLocalSsh());
  results.push(checkLocalRsync());
  results.push(...checkDiskSpace(quick));

  // ====== 远程环境检查 ======
  const ssh = new SSHClient(envConfig);
  let sshConnected = false;

  try {
    // SSH 连通性
    const sshResult = await checkSSHConnection(ssh, envConfig);
    results.push(sshResult);
    sshConnected = sshResult.status === 'pass';

    if (sshConnected) {
      // 并行执行远程检查
      const remoteResults = await Promise.all([
        checkRemoteDiskSpace(ssh, envConfig),
        checkRemoteDirPermissions(ssh, envConfig),
        checkRemoteRsync(ssh)
      ]);
      results.push(...remoteResults);
    }
  } catch (error) {
    results.push({
      name: '远程环境检查',
      status: 'fail',
      message: `远程检查异常: ${error.message}`
    });
  } finally {
    if (sshConnected) {
      try { await ssh.disconnect(); } catch (e) { /* 忽略 */ }
    }
  }

  // 判断是否可以部署
  const failCount = results.filter(r => r.status === 'fail').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const canDeploy = failCount === 0;

  // 打印报告
  printCheckReport(results, environment, canDeploy);

  return { results, canDeploy, failCount, warnCount };
}

/**
 * 校验服务器配置必填字段
 */
function validateServerConfig(envConfig, environment) {
  const results = [];

  // 必填字段检查
  const required = [
    ['sshHost', 'SSH 主机地址'],
    ['sshUser', 'SSH 用户名'],
    ['sshKeyPath', 'SSH 密钥路径'],
    ['deployDir', '部署目录'],
    ['backupDir', '备份目录']
  ];

  for (const [key, label] of required) {
    if (!envConfig[key]) {
      results.push({
        name: '配置校验',
        status: 'fail',
        message: `缺少必填配置: ${label} (${key})`
      });
    }
  }

  // SSH 密钥文件存在性
  if (envConfig.sshKeyPath) {
    const keyPath = envConfig.sshKeyPath
      .replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/root');
    if (!fs.existsSync(keyPath)) {
      results.push({
        name: '配置校验',
        status: 'fail',
        message: `SSH 密钥文件不存在: ${keyPath}`
      });
    }
  }

  // 路径格式校验
  if (envConfig.deployDir && !envConfig.deployDir.startsWith('/')) {
    results.push({
      name: '配置校验',
      status: 'fail',
      message: `部署目录必须是绝对路径: ${envConfig.deployDir}`
    });
  }
  if (envConfig.backupDir && !envConfig.backupDir.startsWith('/')) {
    results.push({
      name: '配置校验',
      status: 'fail',
      message: `备份目录必须是绝对路径: ${envConfig.backupDir}`
    });
  }

  // 如果所有必填字段都有，标记通过
  if (results.length === 0) {
    results.push({
      name: '配置校验',
      status: 'pass',
      message: `环境 [${environment}] 配置完整`
    });
  }

  return results;
}

/**
 * 检查 Node.js 版本
 */
function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= 18) {
    return {
      name: 'Node.js 版本',
      status: 'pass',
      message: `v${version} (>=18.0.0)`
    };
  }
  return {
    name: 'Node.js 版本',
    status: 'fail',
    message: `v${version}，需要 >=18.0.0`
  };
}

/**
 * 检查 Git 是否可用
 */
function checkGitAvailable() {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    return {
      name: 'Git 可用性',
      status: 'pass',
      message: version
    };
  } catch {
    return {
      name: 'Git 可用性',
      status: 'fail',
      message: 'Git 未安装或不在 PATH 中'
    };
  }
}

/**
 * 检查 Git 工作区状态
 */
function checkGitStatus() {
  try {
    const branch = getCurrentBranch();
    const { clean, changes } = checkUncommittedChanges();

    if (clean) {
      return {
        name: 'Git 工作区',
        status: 'pass',
        message: `干净，当前分支: ${branch}`
      };
    }
    return {
      name: 'Git 工作区',
      status: 'warn',
      message: `有 ${changes.length} 个未提交改动，当前分支: ${branch}`,
      detail: changes.slice(0, 5).join(', ') + (changes.length > 5 ? ` 等${changes.length}个文件` : '')
    };
  } catch (error) {
    return {
      name: 'Git 工作区',
      status: 'warn',
      message: `无法检测: ${error.message}`
    };
  }
}

/**
 * 检查本地磁盘空间
 */
function checkDiskSpace(quick = false) {
  const results = [];

  // 检查当前工作目录所在磁盘
  try {
    const cwd = process.cwd();
    // Windows: wmic 或 fs 判断；Unix: df
    if (process.platform === 'win32') {
      // Windows 下跳过详细磁盘检查（wmic 太慢），只做基本判断
      if (!quick) {
        results.push({
          name: '本地磁盘空间',
          status: 'pass',
          message: 'Windows 环境，跳过详细磁盘检查（使用 --quick 可加速）'
        });
      }
    } else {
      const dfOutput = execSync(`df -h "${cwd}" | tail -1`, { encoding: 'utf-8' });
      const parts = dfOutput.trim().split(/\s+/);
      if (parts.length >= 5) {
        const available = parts[3]; // Avail 列
        const usePercent = parseInt(parts[4], 10);
        if (usePercent > 90) {
          results.push({
            name: '本地磁盘空间',
            status: 'warn',
            message: `可用: ${available}，使用率: ${usePercent}%`
          });
        } else {
          results.push({
            name: '本地磁盘空间',
            status: 'pass',
            message: `可用: ${available}，使用率: ${usePercent}%`
          });
        }
      }
    }
  } catch {
    results.push({
      name: '本地磁盘空间',
      status: 'warn',
      message: '无法检测本地磁盘空间'
    });
  }

  return results;
}

/**
 * 检查本地 ssh 命令是否可用（管道流传输需要）
 */
function checkLocalSsh() {
  try {
    const version = execSync('ssh -V 2>&1', { encoding: 'utf-8' }).trim();
    return {
      name: '本地 SSH 命令',
      status: 'pass',
      message: version
    };
  } catch {
    return {
      name: '本地 SSH 命令',
      status: 'warn',
      message: 'ssh 命令不可用，将降级为 SFTP 模式'
    };
  }
}

/**
 * 检查本地 rsync 是否可用
 */
function checkLocalRsync() {
  try {
    const version = execSync('rsync --version', { encoding: 'utf-8' }).trim();
    const firstLine = version.split('\n')[0];
    return {
      name: '本地 rsync',
      status: 'pass',
      message: `${firstLine}（将优先使用增量同步）`
    };
  } catch {
    return {
      name: '本地 rsync',
      status: 'warn',
      message: 'rsync 不可用（将使用 tar 管道流传输）'
    };
  }
}

/**
 * 检查远程 rsync 是否可用
 */
async function checkRemoteRsync(ssh) {
  try {
    const result = await ssh.execCommand(
      'command -v rsync 2>/dev/null && rsync --version 2>/dev/null | head -1 || echo "NOT_FOUND"'
    );
    if (result.includes('NOT_FOUND')) {
      return {
        name: '服务器 rsync',
        status: 'warn',
        message: '未安装 rsync（rsync 模式不可用）'
      };
    }
    return {
      name: '服务器 rsync',
      status: 'pass',
      message: result.trim()
    };
  } catch {
    return {
      name: '服务器 rsync',
      status: 'warn',
      message: '无法检测（rsync 模式可能不可用）'
    };
  }
}

/**
 * 检查 SSH 连接
 */
async function checkSSHConnection(ssh, envConfig) {
  const startTime = Date.now();
  try {
    await ssh.connect();
    const duration = Date.now() - startTime;
    return {
      name: 'SSH 连通性',
      status: 'pass',
      message: `${envConfig.sshUser}@${envConfig.sshHost}:${envConfig.sshPort || 22} (${duration}ms)`
    };
  } catch (error) {
    return {
      name: 'SSH 连通性',
      status: 'fail',
      message: `${envConfig.sshUser}@${envConfig.sshHost} — ${error.message}`
    };
  }
}

/**
 * 检查远程磁盘空间
 */
async function checkRemoteDiskSpace(ssh, envConfig) {
  try {
    const result = await ssh.execCommand(`df -h ${envConfig.deployDir} 2>/dev/null | tail -1`);
    const parts = result.trim().split(/\s+/);
    if (parts.length >= 5) {
      const available = parts[3];
      const usePercent = parseInt(parts[4], 10);
      if (usePercent > 90) {
        return {
          name: '服务器磁盘空间',
          status: 'warn',
          message: `可用: ${available}，使用率: ${usePercent}%`
        };
      }
      return {
        name: '服务器磁盘空间',
        status: 'pass',
        message: `可用: ${available}，使用率: ${usePercent}%`
      };
    }
  } catch {
    // 忽略
  }
  return {
    name: '服务器磁盘空间',
    status: 'warn',
    message: '无法检测（不影响部署）'
  };
}

/**
 * 检查远程目录权限
 */
async function checkRemoteDirPermissions(ssh, envConfig) {
  const dirs = [envConfig.deployDir, envConfig.backupDir];
  const results = [];

  for (const dir of dirs) {
    try {
      // 尝试创建目录并写入测试
      await ssh.execCommand(`mkdir -p ${dir} 2>/dev/null && touch ${dir}/.fe-build-test 2>/dev/null && rm -f ${dir}/.fe-build-test 2>/dev/null && echo 'OK' || echo 'NO_PERM'`);
      const checkResult = await ssh.execCommand(`test -w ${dir} && echo 'WRITABLE' || echo 'NOT_WRITABLE'`);
      if (checkResult.includes('NOT_WRITABLE')) {
        results.push({
          name: '服务器目录权限',
          status: 'fail',
          message: `${dir} — 不可写`
        });
      }
    } catch {
      results.push({
        name: '服务器目录权限',
        status: 'fail',
        message: `${dir} — 无法检测权限`
      });
    }
  }

  if (results.length === 0) {
    return {
      name: '服务器目录权限',
      status: 'pass',
      message: '部署目录和备份目录均可写'
    };
  }
  return results[0]; // 返回第一个失败
}

/**
 * 打印检查报告
 */
function printCheckReport(results, environment, canDeploy) {
  const passList = results.filter(r => r.status === 'pass');
  const warnList = results.filter(r => r.status === 'warn');
  const failList = results.filter(r => r.status === 'fail');

  console.log('\n========================================');
  console.log(`  🔍 环境预检报告 — ${environment}`);
  console.log('========================================');

  // 通过的检查
  if (passList.length > 0) {
    console.log(`\n  ✅ 通过 (${passList.length}):`);
    for (const r of passList) {
      console.log(`     ${r.name}: ${r.message}`);
    }
  }

  // 警告
  if (warnList.length > 0) {
    console.log(`\n  ⚠️  警告 (${warnList.length}):`);
    for (const r of warnList) {
      console.log(`     ${r.name}: ${r.message}`);
      if (r.detail) {
        console.log(`        详情: ${r.detail}`);
      }
    }
  }

  // 阻断
  if (failList.length > 0) {
    console.log(`\n  ❌ 阻断 (${failList.length}):`);
    for (const r of failList) {
      console.log(`     ${r.name}: ${r.message}`);
    }
  }

  console.log('\n----------------------------------------');
  if (canDeploy) {
    console.log('  ✅ 预检通过，可以部署');
  } else {
    console.log('  ❌ 预检未通过，请修复阻断项后重试');
  }
  console.log('========================================\n');
}

export default {
  runPreflightChecks
};
