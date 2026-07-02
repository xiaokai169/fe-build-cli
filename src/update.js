import { execSync } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devNull } from './utils.js';

/**
 * 更新模块
 * 支持检查更新和自动更新
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 获取当前版本
 * @returns {string} 当前版本号
 */
export function getCurrentVersion() {
  try {
    // 从 package.json 获取版本
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error) {
    // 通过 npm 命令获取
    try {
      const version = execSync('npm list fe-build-cli --global --depth=0', { encoding: 'utf-8' });
      const match = version.match(/fe-build-cli@(\d+\.\d+\.\d+)/);
      return match ? match[1] : '未知';
    } catch (e) {
      return '未知';
    }
  }
}

/**
 * 获取 npm 最新版本
 * @returns {Promise<string>} 最新版本号
 */
export async function getLatestVersion() {
  try {
    const nullDevice = devNull();
    const result = execSync(`npm view fe-build-cli version --silent 2>${nullDevice}`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'] // 隐藏 stderr
    });
    return result.trim();
  } catch (error) {
    throw new Error('无法获取最新版本，请检查网络连接或 npm 源');
  }
}

/**
 * 检查是否有更新
 * @returns {Promise<object>} 更新信息
 */
export async function checkForUpdate() {
  const currentVersion = await getCurrentVersion();
  const latestVersion = await getLatestVersion();

  const hasUpdate = currentVersion !== latestVersion && latestVersion !== '未知';

  return {
    currentVersion,
    latestVersion,
    hasUpdate
  };
}

/**
 * 执行更新
 * @param {boolean} global - 是否全局更新
 * @returns {Promise<boolean>} 是否成功
 */
export async function performUpdate(global = true) {
  try {
    console.log('\n正在更新 fe-build-cli...');

    const command = global
      ? 'npm update fe-build-cli --global'
      : 'npm update fe-build-cli';

    execSync(command, { stdio: 'inherit', timeout: 60000 });

    console.log('\n✅ 更新完成!');

    // 显示更新后的版本
    const newVersion = await getLatestVersion();
    console.log(`当前版本: ${newVersion}`);

    return true;
  } catch (error) {
    console.error('\n❌ 更新失败:', error.message);
    console.log('\n请尝试手动更新:');
    console.log('  npm update fe-build-cli --global');
    return false;
  }
}

/**
 * 显示更新信息
 */
export async function showUpdateInfo() {
  console.log('\n========================================');
  console.log('  🔄 fe-build-cli 版本检查');
  console.log('========================================');

  try {
    const info = await checkForUpdate();

    console.log(`当前版本: ${info.currentVersion}`);
    console.log(`最新版本: ${info.latestVersion}`);

    if (info.hasUpdate) {
      console.log('\n📌 发现新版本!');
      console.log('\n更新方法:');
      console.log('  fe-build update          # 自动更新');
      console.log('  npm update fe-build-cli --global  # 手动更新');
    } else {
      console.log('\n✅ 已是最新版本');
    }

    console.log('========================================');

    return info;
  } catch (error) {
    console.error('❌ 检查更新失败:', error.message);
    console.log('\n请检查网络连接或手动更新:');
    console.log('  npm update fe-build-cli --global');
    return null;
  }
}

export default {
  getCurrentVersion,
  getLatestVersion,
  checkForUpdate,
  performUpdate,
  showUpdateInfo
};
