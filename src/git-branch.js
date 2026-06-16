import { execSync } from 'node:child_process';

/**
 * Git 分支管理模块
 * 支持当前分支发布和主分支发布两种模式
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
 * 切换到指定分支
 * @param {string} branchName - 分支名
 */
export function checkoutBranch(branchName) {
  try {
    console.log(`\n📌 切换到分支: ${branchName}`);
    execSync(`git checkout ${branchName}`, { stdio: 'inherit' });
    console.log(`✅ 已切换到 ${branchName}`);
  } catch (error) {
    throw new Error(`切换到分支 ${branchName} 失败: ${error.message}`);
  }
}

/**
 * 拉取远程分支最新代码
 * @param {string} branchName - 分支名
 */
export function pullBranch(branchName) {
  try {
    console.log(`\n📥 拉取 ${branchName} 最新代码...`);
    execSync(`git pull origin ${branchName}`, { stdio: 'inherit' });
    console.log(`✅ ${branchName} 已更新`);
  } catch (error) {
    console.warn(`⚠️ 拉取 ${branchName} 失败，继续执行...`);
  }
}

/**
 * 合并分支
 * @param {string} sourceBranch - 源分支
 * @param {string} targetBranch - 目标分支（当前所在分支）
 * @returns {boolean} 是否成功
 */
export function mergeBranch(sourceBranch, targetBranch) {
  try {
    console.log(`\n🔀 合并 ${sourceBranch} 到 ${targetBranch}...`);
    execSync(`git merge ${sourceBranch} --no-edit`, { stdio: 'inherit' });
    console.log(`✅ 合并成功`);
    return true;
  } catch (error) {
    console.error(`❌ 合并失败: ${error.message}`);
    // 尝试中止合并
    try {
      execSync('git merge --abort', { stdio: 'inherit' });
      console.log('已中止合并');
    } catch (e) {
      // 忽略
    }
    return false;
  }
}

/**
 * 推送分支到远程
 * @param {string} branchName - 分支名
 */
export function pushBranch(branchName) {
  try {
    console.log(`\n📤 推送 ${branchName} 到远程...`);
    execSync(`git push origin ${branchName}`, { stdio: 'inherit' });
    console.log(`✅ 推送成功`);
  } catch (error) {
    throw new Error(`推送 ${branchName} 失败: ${error.message}`);
  }
}

/**
 * 储藏本地改动（stash）
 * @param {string} branchName - 当前分支名（用于备注）
 * @returns {boolean} 是否成功
 */
export function stashChanges(branchName = '') {
  try {
    console.log('\n📦 储藏本地改动...');
    const stashMessage = branchName
      ? `stash for test deploy from ${branchName}`
      : 'fe-build-cli-auto-stash';
    execSync(`git stash push -m "${stashMessage}"`, { stdio: 'inherit' });
    console.log('✅ 本地改动已储藏');
    return true;
  } catch (error) {
    console.error('❌ 储藏失败:', error.message);
    return false;
  }
}

/**
 * 恢复储藏的改动（stash pop）
 * @returns {boolean} 是否成功
 */
export function stashPop() {
  try {
    console.log('\n📦 恢复储藏的改动...');
    execSync('git stash pop', { stdio: 'inherit' });
    console.log('✅ 本地改动已恢复');
    return true;
  } catch (error) {
    console.error('❌ 恢复失败:', error.message);
    console.log('💡 提示: 可能存在冲突，请手动执行 git stash pop 解决');
    return false;
  }
}

/**
 * 自动提交当前分支的所有改动
 * @param {string} message - 提交信息
 * @returns {boolean} 是否成功
 */
export function autoCommit(message) {
  try {
    console.log('\n📝 自动提交改动...');
    // 添加所有改动
    execSync('git add -A', { stdio: 'inherit' });
    // 提交
    execSync(`git commit -m "${message}"`, { stdio: 'inherit' });
    console.log('✅ 改动已提交');
    return true;
  } catch (error) {
    console.error('❌ 提交失败:', error.message);
    return false;
  }
}

/**
 * 执行主分支发布流程
 * 流程：当前分支 -> 测试分支 -> 主分支
 * @param {object} config - 分支配置
 * @param {string} config.testBranch - 测试分支名
 * @param {string} config.mainBranch - 主分支名
 * @param {boolean} config.pushToRemote - 是否推送到远程
 * @returns {object} 执行结果
 */
export function executeMainBranchFlow(config) {
  const { testBranch, mainBranch, pushToRemote = true } = config;
  const originalBranch = getCurrentBranch();

  console.log('\n========================================');
  console.log('  🌿 主分支发布流程');
  console.log('========================================');
  console.log(`当前分支: ${originalBranch}`);
  console.log(`测试分支: ${testBranch}`);
  console.log(`主分支: ${mainBranch}`);
  console.log('========================================');

  // 检查工作区状态
  const { clean, changes } = checkUncommittedChanges();
  if (!clean) {
    console.error('❌ 工作区有未提交的更改:');
    changes.forEach(change => console.log(`  ${change}`));
    throw new Error('请先提交或暂存更改后再执行发布');
  }

  try {
    // 步骤1: 切换到测试分支并拉取最新代码
    checkoutBranch(testBranch);
    pullBranch(testBranch);

    // 步骤2: 合并当前分支到测试分支
    if (!mergeBranch(originalBranch, testBranch)) {
      throw new Error(`合并 ${originalBranch} 到 ${testBranch} 失败`);
    }

    // 步骤3: 推送测试分支（可选）
    if (pushToRemote) {
      pushBranch(testBranch);
    }

    // 步骤4: 切换到主分支并拉取最新代码
    checkoutBranch(mainBranch);
    pullBranch(mainBranch);

    // 步骤5: 合并测试分支到主分支
    if (!mergeBranch(testBranch, mainBranch)) {
      throw new Error(`合并 ${testBranch} 到 ${mainBranch} 失败`);
    }

    // 步骤6: 推送主分支（可选）
    if (pushToRemote) {
      pushBranch(mainBranch);
    }

    console.log('\n========================================');
    console.log('✅ 主分支发布流程完成');
    console.log(`当前分支: ${mainBranch}`);
    console.log('========================================');

    return {
      success: true,
      originalBranch,
      currentBranch: mainBranch,
      testBranch,
      mainBranch
    };
  } catch (error) {
    // 出错时尝试切回原分支
    try {
      checkoutBranch(originalBranch);
    } catch (e) {
      // 忽略
    }
    throw error;
  }
}

/**
 * 执行当前分支发布流程
 * 不切换分支，直接在当前分支发布
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
    originalBranch: currentBranch,
    currentBranch,
    gitSha
  };
}

/**
 * 执行 test 环境发布流程（智能模式）
 * @param {object} config - 配置
 * @param {string} config.testBranch - test 分支名
 * @param {boolean} config.mergeChanges - 是否合并本地改动
 * @param {boolean} config.pushToRemote - 是否推送到远程
 * @param {function} config.prompt - 交互提示函数
 * @returns {object} 执行结果
 */
export async function executeTestBranchFlow(config) {
  const { testBranch, mergeChanges, pushToRemote = true, prompt } = config;
  const originalBranch = getCurrentBranch();
  const { clean, changes } = checkUncommittedChanges();

  console.log('\n========================================');
  console.log('  🌿 Test 环境发布流程');
  console.log('========================================');
  console.log(`当前分支: ${originalBranch}`);
  console.log(`Test 分支: ${testBranch}`);
  console.log(`工作区状态: ${clean ? '干净' : '有未提交改动'}`);
  console.log('========================================');

  // 情况1：当前分支本身就是 test
  if (originalBranch === testBranch) {
    console.log('\n✓ 当前已在 test 分支');
    pullBranch(testBranch);
    return {
      success: true,
      originalBranch,
      currentBranch: testBranch,
      needRestore: false,
      hasStash: false
    };
  }

  // 情况2：当前分支 ≠ test，无本地改动
  if (clean) {
    console.log('\n✓ 无本地改动，直接切换发布');
    checkoutBranch(testBranch);
    pullBranch(testBranch);
    return {
      success: true,
      originalBranch,
      currentBranch: testBranch,
      needRestore: true,
      hasStash: false,
      autoRestore: true  // 无改动模式自动切回
    };
  }

  // 情况3：当前分支 ≠ test，有本地改动
  console.log('\n⚠️ 存在未提交的改动:');
  changes.forEach(change => console.log(`  ${change}`));

  // 如果已确定合并选项，直接执行
  if (mergeChanges === true) {
    return await executeTestMergeFlow(originalBranch, testBranch, pushToRemote);
  } else if (mergeChanges === false) {
    return await executeTestStashFlow(originalBranch, testBranch);
  }

  // 否则交互询问
  if (prompt) {
    console.log('\n请选择处理方式:');
    console.log('  1. 合并改动到 test 发布（提交当前分支，合并到 test）');
    console.log('  2. 不合并，暂存改动（stash 储藏，用纯净 test 发布）');

    const answer = await prompt('请输入选项 (1/2): ');

    if (answer === '1') {
      return await executeTestMergeFlow(originalBranch, testBranch, pushToRemote);
    } else if (answer === '2') {
      return await executeTestStashFlow(originalBranch, testBranch);
    } else {
      throw new Error('无效选项，已取消发布');
    }
  }

  throw new Error('存在未提交改动，请选择处理方式');
}

/**
 * 执行合并流程（提交当前分支，合并到 test）
 */
async function executeTestMergeFlow(originalBranch, testBranch, pushToRemote) {
  console.log('\n========================================');
  console.log('  🔀 合并改动发布模式');
  console.log('========================================');

  try {
    // 1. 自动提交当前分支改动（备注包含原分支名）
    const commitMessage = `auto commit: deploy test from ${originalBranch}`;
    if (!autoCommit(commitMessage)) {
      throw new Error('自动提交失败');
    }

    // 2. 推送当前分支到远程
    if (pushToRemote) {
      pushBranch(originalBranch);
    }

    // 3. 切换到 test 分支
    checkoutBranch(testBranch);
    pullBranch(testBranch);

    // 4. 合并当前分支到 test
    if (!mergeBranch(originalBranch, testBranch)) {
      // 合并冲突，切回原分支
      checkoutBranch(originalBranch);
      throw new Error(`合并冲突: ${originalBranch} 到 ${testBranch}，请手动解决冲突后重新发布`);
    }

    // 5. 推送 test 分支
    if (pushToRemote) {
      pushBranch(testBranch);
    }

    console.log('\n========================================');
    console.log('✅ 合并发布流程完成');
    console.log(`当前分支: ${testBranch}`);
    console.log('========================================');

    return {
      success: true,
      originalBranch,
      currentBranch: testBranch,
      needRestore: true,
      hasStash: false,
      merged: true,
      autoRestore: true  // 合并模式自动切回
    };
  } catch (error) {
    // 出错时切回原分支
    try {
      checkoutBranch(originalBranch);
    } catch (e) {
      // 忽略
    }
    throw error;
  }
}

/**
 * 执行暂存流程（stash 储藏，用纯净 test 发布）
 */
async function executeTestStashFlow(originalBranch, testBranch) {
  console.log('\n========================================');
  console.log('  📦 暂存改动发布模式');
  console.log('========================================');

  try {
    // 1. 储藏本地改动（备注包含原分支名）
    if (!stashChanges(originalBranch)) {
      throw new Error('储藏改动失败');
    }

    // 2. 切换到 test 分支
    checkoutBranch(testBranch);
    pullBranch(testBranch);

    console.log('\n========================================');
    console.log('✅ 暂存发布流程完成');
    console.log(`当前分支: ${testBranch}`);
    console.log('========================================');

    return {
      success: true,
      originalBranch,
      currentBranch: testBranch,
      needRestore: true,
      hasStash: true,
      autoRestore: false  // stash 模式询问是否切回
    };
  } catch (error) {
    // 出错时切回原分支并恢复 stash
    try {
      checkoutBranch(originalBranch);
      stashPop();
    } catch (e) {
      // 忽略
    }
    throw error;
  }
}

/**
 * 发布后切回原分支
 * @param {string} originalBranch - 原分支名
 * @param {boolean} hasStash - 是否有储藏的改动
 */
export function restoreBranch(originalBranch, hasStash = false) {
  const currentBranch = getCurrentBranch();
  if (currentBranch !== originalBranch) {
    console.log(`\n📌 切回原分支: ${originalBranch}`);
    checkoutBranch(originalBranch);
  }

  // 如果有储藏的改动，提示恢复
  if (hasStash) {
    console.log('\n💡 提示: 本地改动已储藏，执行以下命令恢复:');
    console.log('   git stash pop');
  }
}

export default {
  getCurrentBranch,
  getGitSha,
  isWorkingTreeClean,
  checkUncommittedChanges,
  checkoutBranch,
  pullBranch,
  mergeBranch,
  pushBranch,
  stashChanges,
  stashPop,
  autoCommit,
  executeMainBranchFlow,
  executeCurrentBranchFlow,
  executeTestBranchFlow,
  restoreBranch
};