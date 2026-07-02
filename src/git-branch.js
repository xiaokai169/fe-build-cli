import { execSync } from 'node:child_process';

/**
 * Git 分支管理模块
 * 提供基本的 Git 信息查询功能（已移除分支合并操作）
 */

/**
 * 获取当前 Git 分支名称
 * @returns {string} 当前分支名
 */
export function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch (error) {
    console.error('❌ 获取当前分支失败:', error.message);
    throw new Error('无法获取当前分支，请确保在 Git 仓库中执行');
  }
}

/**
 * 获取 Git 提交 SHA（短格式）
 * @returns {string} 短 SHA
 */
export function getGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch (error) {
    return 'local';
  }
}

/**
 * 获取最近一次 Git 提交信息
 * @returns {string} 提交信息
 */
export function getGitCommitMessage() {
  try {
    return execSync('git log -1 --pretty=format:"%s"', { encoding: 'utf-8' }).trim();
  } catch (error) {
    return '';
  }
}

/**
 * 获取最近 N 次 Git 提交信息
 * @param {number} count - 提交数量
 * @returns {string} 提交信息列表
 */
export function getGitCommitMessages(count = 3) {
  try {
    const messages = execSync(`git log -${count} --pretty=format:"%s"`, { encoding: 'utf-8' }).trim();
    return messages.split('\n').map(m => `- ${m}`).join('\n');
  } catch (error) {
    return '';
  }
}

/**
 * 检查工作区是否干净
 * @returns {boolean} 是否干净
 */
export function isWorkingTreeClean() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return status === '';
  } catch (error) {
    return false;
  }
}

/**
 * 检查是否有未提交的更改
 * @returns {{ clean: boolean, changes: string[] }} 状态信息
 */
export function checkUncommittedChanges() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    if (status === '') {
      return { clean: true, changes: [] };
    }
    const changes = status.split('\n').filter(line => line.trim());
    return { clean: false, changes };
  } catch (error) {
    return { clean: false, changes: [error.message] };
  }
}

/**
 * 执行当前分支发布流程
 * 不操作任何 Git 分支，仅返回当前分支信息
 * @returns {object} 执行结果
 */
export function executeCurrentBranchFlow() {
  const currentBranch = getCurrentBranch();
  const gitSha = getGitSha();

  console.log('\n========================================');
  console.log('  🌿 当前分支发布模式');
  console.log('========================================');
  console.log(`当前分支: ${currentBranch}`);
  console.log(`提交 SHA: ${gitSha}`);
  console.log('========================================');

  return {
    success: true,
    currentBranch,
    gitSha
  };
}

/**
 * 执行简单发布流程（推荐默认模式）
 * 直接从当前分支构建部署，不做任何分支切换或合并
 * @returns {object} 执行结果
 */
export function executeSimpleFlow() {
  const currentBranch = getCurrentBranch();
  const gitSha = getGitSha();

  console.log('\n========================================');
  console.log('  🌿 简单发布模式 (Simple)');
  console.log('========================================');
  console.log(`当前分支: ${currentBranch}`);
  console.log(`提交 SHA: ${gitSha}`);
  console.log('模式说明: 直接从当前分支构建部署');
  console.log('========================================');

  // 检查工作区（仅警告，不阻断）
  const { clean, changes } = checkUncommittedChanges();
  if (!clean) {
    console.log('\n⚠️  工作区有未提交的改动:');
    changes.forEach(change => console.log(`  ${change}`));
    console.log('  这些改动会被包含在构建中\n');
  }

  return {
    success: true,
    currentBranch,
    gitSha,
    clean
  };
}

export default {
  getCurrentBranch,
  getGitSha,
  getGitCommitMessage,
  getGitCommitMessages,
  isWorkingTreeClean,
  checkUncommittedChanges,
  executeCurrentBranchFlow,
  executeSimpleFlow
};
