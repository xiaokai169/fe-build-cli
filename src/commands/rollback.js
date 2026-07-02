/**
 * 回滚命令模块
 */
import path from 'node:path';
import os from 'node:os';
import SSHClient from '../ssh-client.js';
import { rollbackDeployment, getServerBackupList, getLocalBackupList, rollbackFromLocal } from '../deploy-core.js';
import { sendRollbackNotification } from '../dingtalk.js';
import { DeployLogger } from '../logger.js';
import { createPrompter, getServerNames, getServerConfig } from './_helpers.js';

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * 执行回滚命令
 * @param {object} config - 配置对象
 */
export async function rollbackCommand(config) {
  const serverNames = getServerNames(config);

  if (serverNames.length === 0) {
    console.error('❌ 配置文件中没有找到服务器配置');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const environment = args.find(arg => arg !== 'rollback' && !arg.startsWith('--'));
  const versionIndex = args.indexOf('--version');
  const specifiedVersion = versionIndex !== -1 ? args[versionIndex + 1] : undefined;
  const useLocalBackup = args.includes('--local');
  const useServerBackup = args.includes('--server');
  const yesMode = args.includes('--yes') || args.includes('-y');

  if (!environment || !serverNames.includes(environment)) {
    console.error(`❌ 请指定服务器: ${serverNames.join(' 或 ')}`);
    console.error(`用法: fe-build rollback [${serverNames.join('|')}] [--server|--local] [--version <版本号>]`);
    process.exit(1);
  }

  const envConfig = getServerConfig(config, environment);

  if (!envConfig || !envConfig.sshHost) {
    console.error(`❌ ${environment} 配置不完整`);
    process.exit(1);
  }

  // 创建日志记录器
  const logDir = config.logDir || 'logs';
  const localBackupDir = config.localBackupDir || path.join(os.homedir(), 'fe-build-backups');
  const logger = new DeployLogger({ logDir, localBackupDir });
  logger.start();

  console.log('========================================');
  console.log(`开始回滚 ${environment} 环境`);
  console.log(`服务器: ${envConfig.sshHost}`);
  console.log('========================================');

  // 连接服务器
  const ssh = new SSHClient(envConfig);
  await ssh.connect();
  logger.logSSHConnect(envConfig.sshHost, true);

  let backupFile = '';
  let selectedBackup = null;
  let backupSource = 'server';

  try {
    if (specifiedVersion) {
      backupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${specifiedVersion}.tar.gz`;
      console.log(`\n使用指定版本: ${specifiedVersion}`);
      logger.log('INFO', '回滚版本', `指定版本: ${specifiedVersion}`);
    } else {
      // 获取备份列表
      let serverBackups = [];
      let localBackups = [];

      console.log('\n[步骤 1] 获取服务器备份列表...');
      serverBackups = await getServerBackupList(ssh, envConfig);
      console.log(`找到 ${serverBackups.length} 个服务器备份`);

      console.log('\n[步骤 2] 获取本地备份列表...');
      localBackups = getLocalBackupList(localBackupDir, envConfig.backupPrefix);
      console.log(`找到 ${localBackups.length} 个本地备份`);

      if (serverBackups.length === 0 && localBackups.length === 0) {
        logger.log('ERROR', '获取备份', '未找到任何备份文件');
        console.error('❌ 未找到任何备份文件!');
        await ssh.disconnect();
        logger.end('failed');
        process.exit(1);
      }

      // 确定备份来源
      if (useLocalBackup && localBackups.length > 0) {
        backupSource = 'local';
      } else if (useServerBackup && serverBackups.length > 0) {
        backupSource = 'server';
      } else if (!useLocalBackup && !useServerBackup) {
        if (yesMode) {
          backupSource = 'server';
          console.log('\n📌 一键模式：默认使用服务器备份');
        } else {
          const prompter = createPrompter();
          console.log('\n========================================');
          console.log('  📦 选择备份来源');
          console.log('========================================');
          console.log(`  1. 服务器备份 (${serverBackups.length} 个) - 默认`);
          if (localBackups.length > 0) {
            console.log(`  2. 本地备份 (${localBackups.length} 个)`);
          }
          console.log('========================================');

          const sourceAnswer = await prompter.ask(`请选择备份来源 (1${localBackups.length > 0 ? '/2' : ''}): `);
          prompter.close();
          if (sourceAnswer === '2' && localBackups.length > 0) {
            backupSource = 'local';
          } else {
            backupSource = 'server';
          }
        }
      }

      const backups = backupSource === 'server' ? serverBackups : localBackups;

      if (yesMode) {
        selectedBackup = backups[0];
        console.log(`\n📌 一键模式：自动选择最新备份 — ${selectedBackup.version}`);
      } else {
        const prompter = createPrompter();
        console.log(`\n========================================`);
        console.log(`  📦 ${backupSource === 'server' ? '服务器' : '本地'}备份列表`);
        console.log(`========================================`);

        backups.forEach((backup, index) => {
          const sizeStr = backup.size ? ` (${formatFileSize(backup.size)})` : '';
          const timeStr = backup.mtime ? ` - ${backup.mtime.toLocaleDateString('zh-CN')}` : '';
          console.log(`  ${index + 1}. ${backup.version}${sizeStr}${timeStr}`);
        });
        console.log(`========================================`);

        const backupAnswer = await prompter.ask(`请选择要回滚的备份 (1-${backups.length}): `);
        prompter.close();

        const selectedIndex = parseInt(backupAnswer, 10) - 1;

        if (selectedIndex < 0 || selectedIndex >= backups.length) {
          console.error('❌ 无效选择');
          await ssh.disconnect();
          logger.end('failed');
          process.exit(1);
        }

        selectedBackup = backups[selectedIndex];
        console.log(`\n已选择: ${selectedBackup.version}`);
      }
      backupFile = selectedBackup.file;
      logger.log('INFO', '选择备份', `来源: ${backupSource}, 版本: ${selectedBackup.version}`);
    }

    // 如果是本地备份，需要先上传到服务器
    if (backupSource === 'local' && selectedBackup) {
      const remoteFile = await rollbackFromLocal({
        ssh,
        envConfig,
        localBackupFile: backupFile,
        logger
      });
      backupFile = remoteFile;
    }

    // 执行回滚
    await rollbackDeployment({
      environment,
      envConfig,
      specifiedVersion: specifiedVersion || (selectedBackup ? selectedBackup.version : undefined),
      backupFile,
      logger,
      ssh
    });

    await ssh.disconnect();
    logger.end('success');

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
      logger.logDingTalk(true);
    }
  } catch (error) {
    console.error('❌ 回滚失败:', error.message);
    logger.log('ERROR', '回滚失败', error.message);
    logger.end('failed');

    try {
      await ssh.disconnect();
    } catch (e) {
      // 强制销毁连接
      try { ssh.client.destroy(); } catch { /* 忽略 */ }
    }

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
      logger.logDingTalk(false, error.message);
    }

    process.exit(1);
  }
}
