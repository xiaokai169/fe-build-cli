#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deployToServer, rollbackDeployment } from './deploy-core.js';
import {
  getCurrentBranch,
  getGitSha,
  executeMainBranchFlow,
  executeCurrentBranchFlow,
  executeTestBranchFlow,
  restoreBranch,
  stashPop
} from './git-branch.js';
import {
  sendDeploySuccessNotification,
  sendDeployFailureNotification,
  sendRollbackNotification
} from './dingtalk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 交互式提示
 */
function prompt(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 获取配置文件路径
 * 优先级：命令行参数 > 当前目录 > 项目根目录
 */
function getConfigPath() {
  // 命令行参数 --config 指定的路径
  const configIndex = process.argv.indexOf('--config');
  if (configIndex !== -1 && process.argv[configIndex + 1]) {
    return path.resolve(process.argv[configIndex + 1]);
  }

  // 当前目录下的 fe-build.config.js
  const localConfig = path.join(process.cwd(), 'fe-build.config.js');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

  // scripts 目录下的 deploy.config.js（兼容旧项目）
  const scriptsConfig = path.join(process.cwd(), 'scripts', 'deploy.config.js');
  if (fs.existsSync(scriptsConfig)) {
    return scriptsConfig;
  }

  return null;
}

/**
 * 加载配置文件
 */
async function loadConfig() {
  const configPath = getConfigPath();

  if (!configPath) {
    console.error('❌ 未找到配置文件!');
    console.error('请创建 fe-build.config.js 或使用 --config 参数指定配置文件路径');
    console.error('\n配置文件示例:');
    console.error(`
export default {
  // 分支配置（可选，用于主分支发布模式）
  branches: {
    test: 'test',      // 测试分支名
    main: 'main'       // 主分支名
  },
  // 发布模式: 'main' (主分支发布) 或 'current' (当前分支发布)
  deployMode: 'main',
  // 服务器配置
  servers: {
    production: {
      sshHost: 'your-server.com',
      sshUser: 'deployer',
      sshKeyPath: '~/.ssh/id_rsa',
      deployUrl: 'https://your-domain.com',
      backupDir: '/www/backups/your-app',
      deployDir: '/www/your-app',
      backupPrefix: 'backup',
      buildMode: 'production',
      protectedDirs: ['webgl']
    }
  }
};
    `);
    process.exit(1);
  }

  console.log(`📄 使用配置文件: ${configPath}`);

  try {
    // Windows 下需要将路径转换为 file:// URL
    const configUrl = pathToFileURL(configPath).href;
    const config = (await import(configUrl)).default;
    return config;
  } catch (error) {
    console.error(`❌ 加载配置文件失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 从配置中获取服务器列表
 */
function getServerNames(config) {
  // 新格式：servers 对象
  if (config.servers) {
    return Object.keys(config.servers).filter(k => config.servers[k].sshHost !== undefined);
  }
  // 旧格式兼容：直接在根对象配置服务器
  return Object.keys(config).filter(k => config[k].sshHost !== undefined);
}

/**
 * 获取服务器配置
 */
function getServerConfig(config, serverName) {
  if (config.servers) {
    return config.servers[serverName];
  }
  return config[serverName];
}

/**
 * 生成构建版本号
 */
function generateBuildVersion() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  let gitSha = 'local';
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch (e) {
    // 忽略
  }
  return `build-${timestamp}-${gitSha}`;
}

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
fe-build-cli - 前端项目打包部署工具

用法:
  fe-build [命令] [选项]

命令:
  deploy [环境]     部署到指定环境（默认命令）
  rollback [环境]   回滚到上一版本
  help              显示帮助信息

选项:
  --config <路径>    指定配置文件路径
  --current-branch   使用当前分支发布（不切换分支）
  --main-branch      使用主分支发布流程（合并到测试分支再合并到主分支）
  --test-branch      使用 test 环境发布流程（智能处理本地改动）
  --merge            test 发布时合并本地改动（提交+推送+合并）
  --no-merge         test 发布时不合并，使用 stash 储藏本地改动
  --skip-build       跳过构建步骤
  --no-push          发布时不推送到远程

示例:
  fe-build                    # 交互式选择环境部署
  fe-build deploy production  # 部署到生产环境
  fe-build deploy test        # 部署到测试环境（使用配置的 deployMode）
  fe-build --test-branch      # test 环境发布（智能处理本地改动）
  fe-build --test-branch --merge    # test 发布，合并本地改动
  fe-build --test-branch --no-merge # test 发布，stash 储藏改动
  fe-build --current-branch   # 当前分支发布
  fe-build --main-branch      # 主分支发布流程
  fe-build rollback production # 回滚生产环境

配置文件 (fe-build.config.js):
  export default {
    // 分支配置
    branches: {
      test: 'test',      // 测试分支名
      main: 'main'       // 主分支名
    },
    // 发布模式: 'main' 或 'current'
    deployMode: 'main',
    // 服务器配置
    servers: {
      production: {
        sshHost: 'server.com',
        sshUser: 'deployer',
        sshKeyPath: '~/.ssh/id_rsa',
        deployUrl: 'https://domain.com',
        backupDir: '/www/backups/app',
        deployDir: '/www/app',
        backupPrefix: 'backup',
        buildMode: 'production',
        protectedDirs: ['webgl']
      }
    }
  };
`);
}

/**
 * 主部署命令
 */
async function deployCommand(config) {
  const serverNames = getServerNames(config);

  if (serverNames.length === 0) {
    console.error('❌ 配置文件中没有找到服务器配置');
    process.exit(1);
  }

  // 解析命令行参数
  const args = process.argv.slice(2);
  const useCurrentBranch = args.includes('--current-branch');
  const useMainBranch = args.includes('--main-branch');
  const useTestBranch = args.includes('--test-branch');
  const useMerge = args.includes('--merge');
  const useNoMerge = args.includes('--no-merge');
  const skipBuild = args.includes('--skip-build');
  const noPush = args.includes('--no-push');

  // 获取目标环境（排除 deploy 命令本身）
  const argEnv = args.find(arg => arg !== 'deploy' && !arg.startsWith('--'));
  let selectedServers = [];

  const validArgs = [...serverNames, 'all'];
  if (argEnv && validArgs.includes(argEnv)) {
    selectedServers = argEnv === 'all' ? serverNames : [argEnv];
  } else {
    // 交互式选择
    console.log('\n========================================');
    console.log('  🚀 请选择部署目标');
    console.log('========================================');
    serverNames.forEach((name, i) => {
      const envConfig = getServerConfig(config, name);
      const label = envConfig ? `${name} - ${envConfig.deployUrl || envConfig.sshHost}` : name;
      console.log(`  ${i + 1}. ${label}`);
    });
    console.log(`  ${serverNames.length + 1}. 全部服务器`);
    console.log('========================================');

    const answer = await prompt(`请输入选项 (1-${serverNames.length + 1}): `);
    const choiceIdx = parseInt(answer, 10);
    if (choiceIdx >= 1 && choiceIdx <= serverNames.length) {
      selectedServers = [serverNames[choiceIdx - 1]];
    } else if (choiceIdx === serverNames.length + 1) {
      selectedServers = serverNames;
    } else {
      console.error('❌ 无效选项');
      process.exit(1);
    }
  }

  // 确定发布模式（根据部署环境自动选择）
  let deployMode = config.deployMode || 'main'; // 默认主分支发布

  // 命令行参数优先
  if (useTestBranch) {
    deployMode = 'test';
  } else if (useCurrentBranch) {
    deployMode = 'current';
  } else if (useMainBranch) {
    deployMode = 'main';
  } else {
    // 自动根据部署环境选择发布模式
    // test 环境 → test 发布模式
    // production 环境 → main 发布模式
    const targetEnv = selectedServers[0];
    if (targetEnv === 'test') {
      deployMode = 'test';
      console.log('\n📌 自动识别：部署到 test 环境，使用 test 发布模式');
    } else if (targetEnv === 'production') {
      deployMode = 'main';
      console.log('\n📌 自动识别：部署到 production 环境，使用 main 发布模式');
    }
  }

  // 执行分支发布流程
  let branchResult = null;
  let originalBranch = getCurrentBranch(); // 记录原始分支
  let needRestore = false;
  let hasStash = false;
  let autoRestore = false;  // 是否自动切回（合并模式）

  // 分支流程（Git 操作）
  try {
    if (deployMode === 'test' && !skipBuild) {
      // test 环境发布模式（智能处理本地改动）
      const branches = config.branches || { test: 'test', main: 'main' };

      // 确定合并选项
      let mergeChanges = undefined;
      if (useMerge) {
        mergeChanges = true;
      } else if (useNoMerge) {
        mergeChanges = false;
      }

      branchResult = await executeTestBranchFlow({
        testBranch: branches.test,
        mergeChanges,
        pushToRemote: !noPush,
        prompt
      });
      originalBranch = branchResult.originalBranch;
      needRestore = branchResult.needRestore;
      hasStash = branchResult.hasStash;
      autoRestore = branchResult.autoRestore || false;
    } else if (deployMode === 'main' && !skipBuild) {
      // 主分支发布模式
      const branches = config.branches || { test: 'test', main: 'main' };
      console.log('\n========================================');
      console.log('  🌿 主分支发布模式');
      console.log('========================================');
      console.log(`测试分支: ${branches.test}`);
      console.log(`主分支: ${branches.main}`);
      console.log('========================================');

      const confirmAnswer = await prompt('确认执行主分支发布流程? (y/n): ');
      if (confirmAnswer.toLowerCase() !== 'y') {
        console.log('已取消发布');
        process.exit(0);
      }

      branchResult = executeMainBranchFlow({
        testBranch: branches.test,
        mainBranch: branches.main,
        pushToRemote: !noPush
      });
      originalBranch = branchResult.originalBranch;
      needRestore = true;
    } else if (deployMode === 'current') {
      // 当前分支发布模式
      branchResult = executeCurrentBranchFlow();
      originalBranch = branchResult.currentBranch;
      needRestore = false;
      console.log('📌 当前分支发布模式：不切换分支');
    }
  } catch (branchError) {
    // 分支流程失败，发送钉钉通知
    console.error(`❌ 分支流程失败:`, branchError.message);

    if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
      console.log('\n发送钉钉失败通知...');
      const envConfig = getServerConfig(config, selectedServers[0] || serverNames[0]);
      await sendDeployFailureNotification(config.dingtalk.webhook, {
        environment: selectedServers[0] || serverNames[0],
        buildVersion: '未完成',
        serverHost: envConfig?.sshHost || '未知',
        branch: originalBranch,
        error: `分支流程失败: ${branchError.message}`,
        keyword: config.dingtalk.keyword || '部署'
      });
    }

    // 切回原分支
    restoreBranch(originalBranch, hasStash);
    process.exit(1);
  }

  // 生成构建版本
  const buildVersion = generateBuildVersion();
  const startTime = Date.now();

  // 部署到选中的服务器
  for (let i = 0; i < selectedServers.length; i++) {
    const serverName = selectedServers[i];
    const envConfig = getServerConfig(config, serverName);

    // 校验配置是否完整
    if (!envConfig || !envConfig.sshHost) {
      console.error(`❌ ${serverName} 配置不完整，请检查配置文件`);
      process.exit(1);
    }

    const isFirst = i === 0;

    console.log('\n========================================');
    console.log(`开始部署到 ${serverName}`);
    console.log(`服务器: ${envConfig.sshHost}`);
    console.log(`构建版本: ${buildVersion}`);
    if (selectedServers.length > 1) {
      console.log(`进度: ${i + 1}/${selectedServers.length}`);
    }
    console.log('========================================');

    try {
      await deployToServer({
        environment: serverName,
        envConfig,
        buildVersion,
        skipBuild: skipBuild || !isFirst,
        skipLocalCleanup: i < selectedServers.length - 1
      });

      // 部署成功，发送钉钉通知
      const duration = Math.round((Date.now() - startTime) / 1000);
      const currentBranch = getCurrentBranch();

      if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
        console.log('\n发送钉钉通知...');
        await sendDeploySuccessNotification(config.dingtalk.webhook, {
          environment: serverName,
          buildVersion,
          serverHost: envConfig.sshHost,
          deployUrl: envConfig.deployUrl,
          branch: currentBranch,
          deployMode,
          duration: `${duration}秒`,
          keyword: config.dingtalk.keyword || '部署'
        });
      }
    } catch (error) {
      console.error(`❌ 部署到 ${serverName} 失败:`, error.message);

      // 部署失败，发送钉钉通知
      const currentBranch = getCurrentBranch();
      if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
        console.log('\n发送钉钉失败通知...');
        await sendDeployFailureNotification(config.dingtalk.webhook, {
          environment: serverName,
          buildVersion,
          serverHost: envConfig.sshHost,
          branch: currentBranch,
          error: error.message,
          keyword: config.dingtalk.keyword || '部署'
        });
      }

      // 出错时切回原分支
      if (needRestore && originalBranch) {
        restoreBranch(originalBranch, hasStash);
      }
      process.exit(1);
    }
  }

  // 部署完成后切回原分支
  if (needRestore && originalBranch) {
    // 合并模式：自动切回原分支
    if (autoRestore) {
      console.log('\n📌 自动切回原分支...');
      restoreBranch(originalBranch, false);
      console.log(`✅ 已切回 ${originalBranch}，可继续开发`);
    } else {
      // stash 模式：询问是否切回
      const returnAnswer = await prompt('\n是否切回原分支? (y/n): ');
      if (returnAnswer.toLowerCase() === 'y') {
        restoreBranch(originalBranch, hasStash);
      } else if (hasStash) {
        console.log('\n💡 提示: 本地改动已储藏，执行以下命令恢复:');
        console.log('   git stash pop');
      }
    }
  }
}

/**
 * 回滚命令
 */
async function rollbackCommand(config) {
  const serverNames = getServerNames(config);

  if (serverNames.length === 0) {
    console.error('❌ 配置文件中没有找到服务器配置');
    process.exit(1);
  }

  // 获取目标环境（排除 rollback 命令本身）
  const args = process.argv.slice(2);
  const environment = args.find(arg => arg !== 'rollback' && !arg.startsWith('--'));
  const versionIndex = args.indexOf('--version');
  const specifiedVersion = versionIndex !== -1 ? args[versionIndex + 1] : undefined;

  if (!environment || !serverNames.includes(environment)) {
    console.error(`❌ 请指定服务器: ${serverNames.join(' 或 ')}`);
    console.error(`用法: fe-build rollback [${serverNames.join('|')}] [--version <版本号>]`);
    process.exit(1);
  }

  const envConfig = getServerConfig(config, environment);

  if (!envConfig || !envConfig.sshHost) {
    console.error(`❌ ${environment} 配置不完整`);
    process.exit(1);
  }

  let backupFile = '';
  let success = false;

  try {
    // 执行回滚，获取备份文件信息
    backupFile = specifiedVersion
      ? `${envConfig.backupDir}/${envConfig.backupPrefix}-${specifiedVersion}.tar.gz`
      : '';

    await rollbackDeployment({
      environment,
      envConfig,
      specifiedVersion
    });

    success = true;

    // 回滚成功，发送钉钉通知
    if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
      console.log('\n发送钉钉通知...');
      await sendRollbackNotification(config.dingtalk.webhook, {
        environment,
        backupFile: backupFile || '最新备份',
        serverHost: envConfig.sshHost,
        deployUrl: envConfig.deployUrl,
        success: true,
        keyword: config.dingtalk.keyword || '部署'
      });
    }
  } catch (error) {
    console.error('❌ 回滚失败:', error.message);
    success = false;

    // 回滚失败，发送钉钉通知
    if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
      console.log('\n发送钉钉通知...');
      await sendRollbackNotification(config.dingtalk.webhook, {
        environment,
        backupFile: backupFile || '未知',
        serverHost: envConfig.sshHost,
        deployUrl: envConfig.deployUrl,
        success: false,
        keyword: config.dingtalk.keyword || '部署'
      });
    }

    process.exit(1);
  }
}

/**
 * 主入口
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // 显示帮助
  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // 加载配置
  const config = await loadConfig();

  // 执行命令
  if (command === 'rollback') {
    await rollbackCommand(config);
  } else {
    // 默认执行 deploy
    await deployCommand(config);
  }
}

main().catch(error => {
  console.error('执行失败:', error);
  process.exit(1);
});