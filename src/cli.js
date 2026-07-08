#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkForUpdate, performUpdate, showUpdateInfo, getCurrentVersion } from './update.js';
import { runInit } from './init.js';
import { runPreflightChecks } from './preflight.js';
import { deployCommand } from './commands/deploy.js';
import { rollbackCommand } from './commands/rollback.js';
import { createPrompter, getServerNames, getServerConfig } from './commands/_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 获取配置文件路径
 * 优先级：命令行参数 > 当前目录 > 项目根目录
 */
function getConfigPath() {
  const configIndex = process.argv.indexOf('--config');
  if (configIndex !== -1 && process.argv[configIndex + 1]) {
    return path.resolve(process.argv[configIndex + 1]);
  }

  const localConfig = path.join(process.cwd(), 'fe-build.config.js');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

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
  // 发布模式: 'simple' (推荐) | 'current'
  deployMode: 'simple',
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
    const configUrl = pathToFileURL(configPath).href;
    const config = (await import(configUrl)).default;
    return config;
  } catch (error) {
    console.error(`❌ 加载配置文件失败: ${error.message}`);
    process.exit(1);
  }
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
  init               初始化项目配置（交互式引导创建 fe-build.config.js）
  check [环境]       环境预检（检查本地和远程环境是否就绪，不执行部署）
  deploy [环境]      部署到指定环境（默认命令）
  rollback [环境]    回滚到指定版本（交互选择备份来源）
  update             检查并更新到最新版本
  update --force     自动更新（无需确认）
  check-update       仅检查是否有新版本
  version            显示当前版本号
  help               显示帮助信息

选项:
  --yes, -y          一键模式（跳过所有交互确认，使用默认行为）
  --config <路径>    指定配置文件路径
  --skip-build       跳过构建步骤
  --skip-check       跳过部署前环境预检
  --transfer <模式>  传输模式: sftp (默认), pipe, obs, git
  --server           回滚时使用服务器备份（默认）
  --local            回滚时使用本地备份
  --version <版本号>  回滚到指定版本

示例:
  fe-build init                           # 初始化项目配置
  fe-build check production               # 检查生产环境是否就绪
  fe-build                                # 交互式选择环境部署
  fe-build deploy production --yes        # 一键部署到生产环境
  fe-build rollback production            # 回滚生产环境（交互选择）
  fe-build rollback production --server   # 回滚生产环境（服务器备份）
  fe-build rollback production --local    # 回滚生产环境（本地备份）

配置文件 (fe-build.config.js):
  export default {
    // 发布模式: 'simple' (推荐) | 'current'
    deployMode: 'simple',
    // 服务器配置
    servers: {
      production: {
        sshHost: 'server.com',
        sshUser: 'deployer',
        sshPort: 22,
        sshKeyPath: '~/.ssh/id_rsa',
        deployUrl: 'https://domain.com',
        backupDir: '/www/backups/app',
        deployDir: '/www/app',
        backupPrefix: 'backup',
        buildMode: 'production',
        buildCommand: 'yarn build',
        protectedDirs: ['webgl']
      }
    }
  };
`);
}

/**
 * 启动时检查更新
 */
async function checkUpdateOnStart() {
  try {
    const info = await checkForUpdate();
    if (info && info.hasUpdate) {
      console.log('\n========================================');
      console.log('  🔄 发现新版本');
      console.log('========================================');
      console.log(`当前版本: ${info.currentVersion}`);
      console.log(`最新版本: ${info.latestVersion}`);
      console.log('\n更新命令: fe-build update --force');
      console.log('========================================\n');
    }
  } catch (error) {
    // 检查更新失败，不影响主流程
  }
}

/**
 * 初始化命令
 */
async function initCommand() {
  await runInit({ cwd: process.cwd() });
  process.exit(0);
}

/**
 * 环境检查命令
 */
async function checkCommand() {
  const config = await loadConfig();
  const serverNames = getServerNames(config);

  if (serverNames.length === 0) {
    console.error('❌ 配置文件中没有找到服务器配置');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const environment = args.find(arg => arg !== 'check' && !arg.startsWith('--'));

  if (!environment || !serverNames.includes(environment)) {
    console.log(`\n🔍 未指定环境，检查所有服务器: ${serverNames.join(', ')}`);
    let allPassed = true;
    for (const name of serverNames) {
      const envConfig = getServerConfig(config, name);
      const { canDeploy } = await runPreflightChecks({
        environment: name,
        envConfig,
        config,
        quick: false
      });
      if (!canDeploy) allPassed = false;
    }
    if (!allPassed) {
      console.error('❌ 部分环境预检未通过');
      process.exit(1);
    }
    console.log('✅ 所有环境预检通过');
  } else {
    const envConfig = getServerConfig(config, environment);
    if (!envConfig || !envConfig.sshHost) {
      console.error(`❌ ${environment} 配置不完整`);
      process.exit(1);
    }
    const { canDeploy } = await runPreflightChecks({
      environment,
      envConfig,
      config,
      quick: false
    });
    if (!canDeploy) {
      process.exit(1);
    }
  }

  process.exit(0);
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

  // 显示版本
  if (command === 'version' || args.includes('--version') || args.includes('-v')) {
    const version = getCurrentVersion();
    console.log(`fe-build-cli v${version}`);
    process.exit(0);
  }

  // 检查更新
  if (command === 'check-update') {
    await showUpdateInfo();
    process.exit(0);
  }

  // 执行更新
  if (command === 'update') {
    const forceUpdate = args.includes('--force') || args.includes('--auto');
    const info = await showUpdateInfo();

    if (info && info.hasUpdate) {
      if (forceUpdate) {
        await performUpdate(true);
      } else {
        const prompter = createPrompter();
        const answer = await prompter.ask('\n是否立即更新? (y/n): ');
        prompter.close();
        if (answer.toLowerCase() === 'y') {
          await performUpdate(true);
        }
      }
    }
    process.exit(0);
  }

  // init 命令不需要检查更新和加载配置
  if (command === 'init') {
    await initCommand();
    return;
  }

  // 其他命令启动时检查更新（静默检查）
  await checkUpdateOnStart();

  // check 命令需要加载配置但不需要部署
  if (command === 'check') {
    await checkCommand();
    return;
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
