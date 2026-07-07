/**
 * 项目初始化模块
 *
 * 交互式引导创建 fe-build.config.js 配置文件
 * 自动检测项目类型、Git 分支、构建命令等
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCurrentBranch } from './git-branch.js';

/**
 * 交互式提示
 */
function createPrompter() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return {
    ask: (question) => new Promise(resolve => {
      rl.question(question, answer => {
        resolve(answer.trim());
      });
    }),
    close: () => rl.close()
  };
}

/**
 * 自动检测项目信息
 */
function detectProjectInfo(cwd) {
  const info = {
    type: 'unknown',
    buildCommand: 'npm run build',
    hasYarn: false,
    hasPnpm: false,
    branches: { test: 'test', main: 'main' }
  };

  // 检测包管理器
  try {
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
      info.hasYarn = true;
    }
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
      info.hasPnpm = true;
    }
  } catch { /* 忽略 */ }

  // 检测 package.json 中的脚本和框架
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // 检测框架类型
      if (deps.vue || deps['@vue/cli-service']) {
        info.type = 'Vue';
      } else if (deps.react || deps['react-scripts'] || deps['@vitejs/plugin-react']) {
        info.type = 'React';
      } else if (deps['@angular/core']) {
        info.type = 'Angular';
      }

      // 检测构建命令
      if (scripts['build-only']) {
        info.buildCommand = info.hasYarn ? 'yarn build-only' : 'npm run build-only';
      } else if (scripts['build:prod'] || scripts['build-prod']) {
        const key = scripts['build:prod'] ? 'build:prod' : 'build-prod';
        info.buildCommand = info.hasYarn ? `yarn ${key}` : `npm run ${key}`;
      } else if (scripts['build']) {
        info.buildCommand = info.hasYarn ? 'yarn build' : 'npm run build';
      }

      // 检测测试构建命令
      if (scripts['build:test'] || scripts['build-test']) {
        info.buildTestCommand = info.hasYarn
          ? `yarn ${scripts['build:test'] ? 'build:test' : 'build-test'}`
          : `npm run ${scripts['build:test'] ? 'build:test' : 'build-test'}`;
      }

      // 检测 dist 目录
      if (fs.existsSync(path.join(cwd, 'dist'))) {
        info.hasDist = true;
      }
    }
  } catch { /* 忽略 */ }

  // 检测 Git 分支
  try {
    const branches = execSync('git branch -a', { encoding: 'utf-8' });
    const localBranches = branches
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').replace('remotes/origin/', '').trim())
      .filter(b => b && !b.includes('/') && !b.startsWith('*'));

    // 推断主分支名
    if (localBranches.includes('main')) {
      info.branches.main = 'main';
    } else if (localBranches.includes('master')) {
      info.branches.main = 'master';
    }

    // 推断测试分支名
    if (localBranches.includes('test')) {
      info.branches.test = 'test';
    } else if (localBranches.includes('develop')) {
      info.branches.test = 'develop';
    } else if (localBranches.includes('dev')) {
      info.branches.test = 'dev';
    }

    info.currentBranch = getCurrentBranch();
  } catch { /* 忽略 */ }

  return info;
}

/**
 * 生成配置文件内容
 */
function generateConfigContent(answers, projectInfo) {
  const {
    testBranch, mainBranch, deployMode,
    sshHost, sshUser, sshKeyPath, sshPort,
    deployUrl, deployDir, backupDir, backupPrefix,
    buildCommand, buildTestCommand,
    productionBuildMode,
    enableDingtalk, dingtalkWebhook, dingtalkKeyword,
    enableBackupDownload, localBackupDir,
    protectedDirs, transferMode
  } = answers;

  let content = `/**
 * fe-build-cli 配置文件
 * 自动生成于 ${new Date().toLocaleString('zh-CN')}
 */

import process from 'node:process';

export default {
  /**
   * 分支配置
   */
  branches: {
    test: '${testBranch}',
    main: '${mainBranch}'
  },

  /**
   * 发布模式
   * 'simple'  — 简单模式（直接当前分支构建部署，推荐）
   * 'current' — 当前分支发布模式
   */
  deployMode: '${deployMode}',

  /**
   * 服务器配置
   */
  servers: {
    production: {
      // SSH 连接
      sshHost: '${sshHost}',
      sshUser: '${sshUser}',
      sshPort: ${sshPort || 22},
      sshKeyPath: '${sshKeyPath}',

      // 部署路径
      deployUrl: '${deployUrl}',
      deployDir: '${deployDir}',
      backupDir: '${backupDir}',
      backupPrefix: '${backupPrefix}',

      // 构建配置
      buildMode: '${productionBuildMode || 'production'}',
      buildCommand: '${buildCommand}',`;

  if (buildTestCommand) {
    content += `
      // 测试构建命令（如果 test 环境需要不同的构建方式）
      // buildTestCommand: '${buildTestCommand}',`;
  }

  content += `

      // 受保护目录（部署时不会被删除）
      protectedDirs: ${JSON.stringify(protectedDirs || [])},
      // 传输模式: 'pipe' | 'rsync' | 'sftp'
      transferMode: '${transferMode || 'pipe'}'
    }`;

  // 如果用户也配置了测试服务器
  if (answers.configTestServer) {
    content += `,

    test: {
      sshHost: '${answers.testSshHost || 'test-server-ip'}',
      sshUser: '${answers.testSshUser || sshUser}',
      sshPort: ${answers.testSshPort || sshPort || 22},
      sshKeyPath: '${answers.testSshKeyPath || sshKeyPath}',
      deployUrl: '${answers.testDeployUrl || ''}',
      deployDir: '${answers.testDeployDir || '/www/wwwroot/test-app'}',
      backupDir: '${answers.testBackupDir || '/www/wwwroot/backups/test-app'}',
      backupPrefix: '${answers.testBackupPrefix || 'backup-test'}',
      buildMode: 'test',
      buildCommand: '${buildTestCommand || buildCommand}',
      protectedDirs: ${JSON.stringify(protectedDirs || [])},
      transferMode: '${transferMode || 'pipe'}'
    }`;
  }

  content += `
  },

  /**
   * 备份保留数量（默认保留最新 1 个）
   */
  backupRetentionCount: 1,`;

  if (enableDingtalk) {
    content += `

  /**
   * 钉钉通知
   */
  dingtalk: {
    webhook: '${dingtalkWebhook || 'https://oapi.dingtalk.com/robot/send?access_token=your-token'}',
    enabled: true,
    keyword: '${dingtalkKeyword || '部署'}'
  },`;
  }

  content += `

  /**
   * 日志目录
   */
  logDir: 'logs',`;

  // 备份下载配置
  if (enableBackupDownload) {
    content += `

  /**
   * 是否启用备份下载
   */
  enableBackupDownload: true,

  /**
   * 本地备份目录
   */
  localBackupDir: '${localBackupDir || path.join(os.homedir(), 'fe-build-backups')}'`;
  } else {
    content += `

  /**
   * 是否启用备份下载
   */
  enableBackupDownload: false`;
  }

  content += `
};
`;

  return content;
}

/**
 * 执行初始化向导
 * @param {object} [options]
 * @param {string} [options.cwd] - 项目根目录
 * @returns {Promise<string>} 生成的配置文件路径
 */
export async function runInit(options = {}) {
  const cwd = options.cwd || process.cwd();
  const prompter = createPrompter();
  const projectInfo = detectProjectInfo(cwd);

  console.log('\n========================================');
  console.log('  🚀 fe-build-cli 项目初始化向导');
  console.log('========================================\n');

  // 检查是否已存在配置文件
  const configPath = path.join(cwd, 'fe-build.config.js');
  if (fs.existsSync(configPath)) {
    console.log('⚠️  已存在 fe-build.config.js');
    const overwrite = await prompter.ask('是否覆盖? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消初始化');
      prompter.close();
      return null;
    }
    console.log();
  }

  const answers = {};

  // ====== 1. 分支配置 ======
  console.log('━━━ 分支配置 ━━━');
  console.log(`检测到项目类型: ${projectInfo.type !== 'unknown' ? projectInfo.type : '未检测到'}`);
  console.log(`检测到包管理器: ${projectInfo.hasPnpm ? 'pnpm' : projectInfo.hasYarn ? 'yarn' : 'npm'}`);

  if (projectInfo.currentBranch) {
    console.log(`当前分支: ${projectInfo.currentBranch}`);
  }

  answers.testBranch = await prompter.ask(
    `测试分支名 (${projectInfo.branches.test}): `
  ) || projectInfo.branches.test;

  answers.mainBranch = await prompter.ask(
    `主分支名 (${projectInfo.branches.main}): `
  ) || projectInfo.branches.main;

  console.log('\n发布模式:');
  console.log('  1. simple  — 简单模式，直接当前分支构建部署（推荐）');
  console.log('  2. current — 当前分支发布模式');
  const modeChoice = await prompter.ask('请选择发布模式 (1): ') || '1';
  const modeMap = { '1': 'simple', '2': 'current' };
  answers.deployMode = modeMap[modeChoice] || 'simple';
  console.log();

  // ====== 2. 服务器配置 ======
  console.log('━━━ 服务器配置 ━━━');

  answers.sshHost = await prompter.ask('服务器 IP 或域名: ');
  if (!answers.sshHost) {
    console.log('❌ 服务器地址不能为空，已取消初始化');
    prompter.close();
    return null;
  }

  answers.sshUser = await prompter.ask('SSH 用户名 (root): ') || 'root';

  // 自动检测 SSH 密钥
  const homeDir = process.env.USERPROFILE || process.env.HOME || '/root';
  let defaultKeyPath = `${homeDir}/.ssh/id_rsa`;
  if (!fs.existsSync(defaultKeyPath)) {
    // 尝试检测其他密钥
    const sshDir = path.join(homeDir, '.ssh');
    if (fs.existsSync(sshDir)) {
      try {
        const files = fs.readdirSync(sshDir);
        const keyFile = files.find(f => f.startsWith('id_') && !f.endsWith('.pub'));
        if (keyFile) {
          defaultKeyPath = `${homeDir}/.ssh/${keyFile}`;
        }
      } catch { /* 忽略 */ }
    }
  }
  answers.sshKeyPath = await prompter.ask(
    `SSH 私钥路径 (${defaultKeyPath}): `
  ) || defaultKeyPath;

  const portInput = await prompter.ask('SSH 端口 (22): ');
  answers.sshPort = portInput ? parseInt(portInput, 10) : 22;

  console.log();

  // ====== 3. 部署配置 ======
  console.log('━━━ 部署配置 ━━━');

  // 尝试从 package.json 读取 name 作为项目名
  let projectName = 'app';
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      projectName = pkg.name || 'app';
    }
  } catch { /* 忽略 */ }

  answers.deployUrl = await prompter.ask('部署后访问地址 (https://your-domain.com): ');
  answers.deployDir = await prompter.ask(
    `部署目录 (/www/wwwroot/${projectName}): `
  ) || `/www/wwwroot/${projectName}`;
  answers.backupDir = await prompter.ask(
    `备份目录 (/www/wwwroot/backups/${projectName}): `
  ) || `/www/wwwroot/backups/${projectName}`;
  answers.backupPrefix = await prompter.ask(
    `备份文件前缀 (backup-production): `
  ) || 'backup-production';

  console.log();

  // ====== 4. 构建配置 ======
  console.log('━━━ 构建配置 ━━━');
  answers.buildCommand = await prompter.ask(
    `构建命令 (${projectInfo.buildCommand}): `
  ) || projectInfo.buildCommand;

  if (projectInfo.buildTestCommand) {
    answers.buildTestCommand = await prompter.ask(
      `测试构建命令 (${projectInfo.buildTestCommand}): `
    ) || projectInfo.buildTestCommand;
  }

  answers.productionBuildMode = await prompter.ask(
    '生产构建模式 (production): '
  ) || 'production';

  const protectedDirsInput = await prompter.ask(
    '受保护目录（逗号分隔，如 webgl,uploads）: '
  );
  answers.protectedDirs = protectedDirsInput
    ? protectedDirsInput.split(',').map(d => d.trim()).filter(Boolean)
    : [];

  // 传输模式选择
  console.log('\n传输模式:');
  console.log('  1. sftp  — SFTP 上传（默认推荐，稳定可靠）');
  console.log('  2. rsync — rsync 增量同步（仅传变更文件，需本地和远程都安装 rsync）');
  console.log('  3. pipe  — tar + zstd 管道流（速度最快但依赖 SSH 通道稳定性）');
  const transferChoice = await prompter.ask('请选择传输模式 (1): ') || '1';
  const transferModeMap = { '1': 'sftp', '2': 'rsync', '3': 'pipe' };
  answers.transferMode = transferModeMap[transferChoice] || 'sftp';

  console.log();

  // ====== 5. 是否配置测试服务器 ======
  console.log('━━━ 测试服务器（可选）━━━');
  const testServerInput = await prompter.ask('是否配置测试服务器? (y/n): ');
  answers.configTestServer = testServerInput.toLowerCase() === 'y';
  if (answers.configTestServer) {
    answers.testSshHost = await prompter.ask('  测试服务器 IP 或域名: ');
    answers.testSshUser = await prompter.ask(`  测试 SSH 用户名 (${answers.sshUser}): `) || answers.sshUser;
    answers.testSshPort = parseInt(await prompter.ask(`  测试 SSH 端口 (${answers.sshPort}): `) || String(answers.sshPort), 10);
    answers.testSshKeyPath = await prompter.ask(`  测试 SSH 私钥路径 (${answers.sshKeyPath}): `) || answers.sshKeyPath;
    answers.testDeployUrl = await prompter.ask('  测试部署地址: ');
    answers.testDeployDir = await prompter.ask(`  测试部署目录 (/www/wwwroot/test-${projectName}): `) || `/www/wwwroot/test-${projectName}`;
    answers.testBackupDir = await prompter.ask(`  测试备份目录 (/www/wwwroot/backups/test-${projectName}): `) || `/www/wwwroot/backups/test-${projectName}`;
    answers.testBackupPrefix = await prompter.ask('  测试备份前缀 (backup-test): ') || 'backup-test';
  }
  console.log();

  // ====== 6. 钉钉通知 ======
  console.log('━━━ 钉钉通知（可选）━━━');
  const dingtalkInput = await prompter.ask('是否启用钉钉通知? (y/n): ');
  answers.enableDingtalk = dingtalkInput.toLowerCase() === 'y';
  if (answers.enableDingtalk) {
    answers.dingtalkWebhook = await prompter.ask('  钉钉机器人 Webhook URL: ');
    answers.dingtalkKeyword = await prompter.ask('  安全关键词 (部署): ') || '部署';
  }

  // ====== 7. 备份下载 ======
  console.log('\n━━━ 备份下载配置（可选）━━━');
  const defaultBackupDir = path.join(os.homedir(), 'fe-build-backups');
  const backupDownloadInput = await prompter.ask('是否启用从服务器下载备份到本地? (y/n): ');
  answers.enableBackupDownload = backupDownloadInput.toLowerCase() === 'y';
  if (answers.enableBackupDownload) {
    answers.localBackupDir = await prompter.ask(`  本地备份存储目录 (${defaultBackupDir}): `) || defaultBackupDir;
  }

  prompter.close();

  // ====== 生成配置文件 ======
  const content = generateConfigContent(answers, projectInfo);

  console.log('\n========================================');
  console.log('  生成的配置文件预览:');
  console.log('========================================');
  console.log(content);
  console.log('========================================');

  const confirmWrite = await createPrompter().ask('\n是否保存配置文件? (y/n): ');
  if (confirmWrite.toLowerCase() !== 'y') {
    console.log('已取消保存');
    return null;
  }

  fs.writeFileSync(configPath, content, 'utf-8');
  console.log(`\n✅ 配置文件已保存: ${configPath}`);

  // 生成后提示
  console.log(`📌 传输模式: ${answers.transferMode === 'rsync' ? 'rsync 增量同步' : answers.transferMode === 'sftp' ? 'SFTP 上传' : 'tar + zstd 管道流直传'}`);

  console.log('\n下一步:');
  console.log(`  1. 检查配置:    fe-build check production`);
  console.log(`  2. 执行部署:    fe-build deploy production --yes`);
  console.log(`  3. 查看帮助:    fe-build help`);

  return configPath;
}

export default {
  runInit
};
