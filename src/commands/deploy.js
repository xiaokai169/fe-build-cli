/**
 * 部署命令模块
 */
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { deployToServer } from '../deploy-core.js';
import {
  getCurrentBranch,
  getGitCommitMessage,
  executeCurrentBranchFlow,
  executeSimpleFlow
} from '../git-branch.js';
import {
  sendDeploySuccessNotification,
  sendDeployFailureNotification
} from '../dingtalk.js';
import { DeployLogger } from '../logger.js';
import { runPreflightChecks } from '../preflight.js';
import { createPrompter, getServerNames, getServerConfig } from './_helpers.js';

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
 * 格式化文件大小
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * 执行部署命令
 * @param {object} config - 配置对象
 */
export async function deployCommand(config) {
  const serverNames = getServerNames(config);

  if (serverNames.length === 0) {
    console.error('❌ 配置文件中没有找到服务器配置');
    process.exit(1);
  }

  // 解析命令行参数
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const skipCheck = args.includes('--skip-check');
  const yesMode = args.includes('--yes') || args.includes('-y');

  // 解析 --transfer 参数
  const transferIndex = args.indexOf('--transfer');
  const transferMode = transferIndex !== -1 && args[transferIndex + 1]
    ? args[transferIndex + 1]
    : undefined;
  if (transferMode && !['pipe', 'rsync', 'sftp', 'obs', 'git'].includes(transferMode)) {
    console.error(`⚠️  无效的传输模式: ${transferMode}，支持: pipe, rsync, sftp, obs, git`);
    console.error('将使用自动检测模式');
  }

  // 获取目标环境（排除 deploy 命令本身）
  const argEnv = args.find(arg => arg !== 'deploy' && !arg.startsWith('--'));
  let selectedServers = [];

  const validArgs = [...serverNames, 'all'];
  if (argEnv && validArgs.includes(argEnv)) {
    selectedServers = argEnv === 'all' ? serverNames : [argEnv];
  } else if (yesMode && serverNames.length === 1) {
    selectedServers = serverNames;
    console.log(`📌 一键模式：自动选择 ${serverNames[0]}`);
  } else if (yesMode) {
    console.error(`❌ 一键模式需要指定部署目标: ${serverNames.join(' | ')}`);
    console.error(`用法: fe-build deploy [${serverNames.join('|')}] --yes`);
    process.exit(1);
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

    const prompter = createPrompter();
    const answer = await prompter.ask(`请输入选项 (1-${serverNames.length + 1}): `);
    prompter.close();

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

  // 确定发布模式：只支持 simple 和 current
  let deployMode = config.deployMode || 'simple';
  // 兼容旧配置中的 main/test 模式，自动降级为 simple
  if (['main', 'test'].includes(deployMode)) {
    console.log(`\n⚠️ 发布模式 "${deployMode}" 已废弃，自动使用 "simple" 模式`);
    deployMode = 'simple';
  }

  if (!['simple', 'current'].includes(deployMode)) {
    deployMode = 'simple';
  }

  console.log(`\n📌 发布模式: ${deployMode === 'simple' ? '简单模式 (直接构建部署)' : '当前分支模式'}`);

  // 创建日志记录器
  const logDir = config.logDir || 'logs';
  const localBackupDir = config.localBackupDir || path.join(os.homedir(), 'fe-build-backups');
  const enableBackupDownload = config.enableBackupDownload !== false;
  const logger = new DeployLogger({ logDir, localBackupDir });
  logger.start();

  // ====== 部署前预检 ======
  if (!skipCheck) {
    console.log('\n========================================');
    console.log('  🔍 部署前环境预检');
    console.log('========================================');

    let allCanDeploy = true;
    for (const serverName of selectedServers) {
      const envConfig = getServerConfig(config, serverName);
      const { canDeploy } = await runPreflightChecks({
        environment: serverName,
        envConfig,
        config,
        quick: false
      });

      if (!canDeploy) {
        allCanDeploy = false;
        console.error(`❌ ${serverName} 预检未通过，请修复阻断项后重试`);
        if (!yesMode) {
          const prompter = createPrompter();
          const continueAnyway = await prompter.ask('是否忽略错误继续部署? (y/n): ');
          prompter.close();
          if (continueAnyway.toLowerCase() !== 'y') {
            logger.end('failed');
            process.exit(1);
          }
        } else {
          logger.end('failed');
          process.exit(1);
        }
      }
    }

    if (allCanDeploy) {
      console.log('✅ 所有环境预检通过\n');
    }
  } else {
    console.log('\n⚠️  已跳过环境预检 (--skip-check)\n');
  }

  // 执行分支发布流程（简化版：只记录当前分支信息）
  let branchResult;
  if (deployMode === 'current') {
    branchResult = executeCurrentBranchFlow();
  } else {
    branchResult = executeSimpleFlow();
  }

  // 生成构建版本
  const buildVersion = generateBuildVersion();
  const startTime = Date.now();

  // 部署到选中的服务器
  for (let i = 0; i < selectedServers.length; i++) {
    const serverName = selectedServers[i];
    const envConfig = getServerConfig(config, serverName);

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
        skipLocalCleanup: i < selectedServers.length - 1,
        logger,
        localBackupDir,
        enableBackupDownload,
        transferMode: ['pipe', 'rsync', 'sftp', 'obs', 'git'].includes(transferMode) ? transferMode : undefined
      });

      logger.end('success');

      // 部署成功，发送钉钉通知
      const duration = Math.round((Date.now() - startTime) / 1000);
      const currentBranch = getCurrentBranch();
      const commitMessage = getGitCommitMessage();

      if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
        console.log('\n发送钉钉通知...');
        await sendDeploySuccessNotification(config.dingtalk.webhook, {
          environment: serverName,
          buildVersion,
          serverHost: envConfig.sshHost,
          deployUrl: envConfig.deployUrl,
          branch: currentBranch,
          deployMode,
          commitMessage,
          duration: `${duration}秒`,
          keyword: config.dingtalk.keyword || '部署'
        });
        logger.logDingTalk(true);
      }
    } catch (error) {
      console.error(`❌ 部署到 ${serverName} 失败:`, error.message);

      logger.end('failed');

      const currentBranch = getCurrentBranch();
      const commitMessage = getGitCommitMessage();
      if (config.dingtalk && config.dingtalk.enabled && config.dingtalk.webhook) {
        console.log('\n发送钉钉失败通知...');
        await sendDeployFailureNotification(config.dingtalk.webhook, {
          environment: serverName,
          buildVersion,
          serverHost: envConfig.sshHost,
          branch: currentBranch,
          commitMessage,
          error: error.message,
          keyword: config.dingtalk.keyword || '部署'
        });
        logger.logDingTalk(false, error.message);
      }

      process.exit(1);
    }
  }
}
