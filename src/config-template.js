import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';

/**
 * fe-build-cli 配置文件模板
 * 将此文件复制到项目根目录并重命名为 fe-build.config.js
 */

/**
 * 校验配置文件
 * @param {object} config - 配置对象
 * @returns {{ valid: boolean, errors: Array<{field: string, message: string}> }}
 */
export function validateConfig(config) {
  const errors = [];

  // 校验服务器配置
  if (config.servers) {
    for (const [envName, envConfig] of Object.entries(config.servers)) {
      if (!envConfig || typeof envConfig !== 'object') continue;

      // 必填字段
      const requiredFields = [
        ['sshHost', 'SSH 主机地址'],
        ['sshUser', 'SSH 用户名'],
        ['sshKeyPath', 'SSH 密钥路径'],
        ['deployDir', '部署目录'],
        ['backupDir', '备份目录']
      ];

      for (const [key, label] of requiredFields) {
        if (!envConfig[key]) {
          errors.push({
            field: `servers.${envName}.${key}`,
            message: `缺少必填配置: ${label}`
          });
        }
      }

      // SSH 密钥存在性
      if (envConfig.sshKeyPath) {
        const keyPath = envConfig.sshKeyPath
          .replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/root');
        if (!fs.existsSync(keyPath)) {
          errors.push({
            field: `servers.${envName}.sshKeyPath`,
            message: `SSH 密钥文件不存在: ${keyPath}`
          });
        }
      }

      // 路径格式校验（服务器路径必须以 / 开头）
      if (envConfig.deployDir && !envConfig.deployDir.startsWith('/')) {
        errors.push({
          field: `servers.${envName}.deployDir`,
          message: `部署目录必须是绝对路径（以 / 开头）: ${envConfig.deployDir}`
        });
      }
      if (envConfig.backupDir && !envConfig.backupDir.startsWith('/')) {
        errors.push({
          field: `servers.${envName}.backupDir`,
          message: `备份目录必须是绝对路径（以 / 开头）: ${envConfig.backupDir}`
        });
      }

      // URL 格式校验
      if (envConfig.deployUrl && !envConfig.deployUrl.startsWith('http')) {
        errors.push({
          field: `servers.${envName}.deployUrl`,
          message: `部署 URL 格式不正确（需以 http 开头）: ${envConfig.deployUrl}`
        });
      }

      // OBS 配置校验（可选）
      if (envConfig.obsConfig) {
        const obsRequired = [
          ['bucket', 'OBS 桶名'],
          ['endpoint', 'OBS Endpoint'],
          ['accessKeyId', 'OBS 访问密钥 ID'],
          ['secretAccessKey', 'OBS 访问密钥']
        ];
        for (const [key, label] of obsRequired) {
          if (!envConfig.obsConfig[key]) {
            errors.push({
              field: `servers.${envName}.obsConfig.${key}`,
              message: `OBS 已启用但缺少必填配置: ${label}`
            });
          }
        }
      }

      // 传输模式校验
      if (envConfig.transferMode && !['pipe', 'sftp', 'obs', 'git'].includes(envConfig.transferMode)) {
        errors.push({
          field: `servers.${envName}.transferMode`,
          message: `无效的传输模式: ${envConfig.transferMode}，支持: pipe, sftp, obs, git`
        });
      }
    }
  }

  // 校验钉钉配置
  if (config.dingtalk && config.dingtalk.enabled) {
    if (!config.dingtalk.webhook) {
      errors.push({
        field: 'dingtalk.webhook',
        message: '钉钉通知已启用但未配置 webhook URL'
      });
    } else if (!config.dingtalk.webhook.startsWith('https://oapi.dingtalk.com/robot/send')) {
      errors.push({
        field: 'dingtalk.webhook',
        message: '钉钉 webhook URL 格式不正确'
      });
    }
  }

  // 校验分支配置
  if (config.branches) {
    if (!config.branches.test) {
      errors.push({
        field: 'branches.test',
        message: '测试分支名未配置'
      });
    }
    if (!config.branches.main) {
      errors.push({
        field: 'branches.main',
        message: '主分支名未配置'
      });
    }
  }

  // 校验构建命令
  if (!config.servers) {
    errors.push({
      field: 'servers',
      message: '未配置任何服务器'
    });
  }

  if (config.deployMode && !['simple', 'current'].includes(config.deployMode)) {
    errors.push({
      field: 'deployMode',
      message: `无效的发布模式: ${config.deployMode}，支持: simple, current`
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export default {
  /**
   * 分支配置（用于主分支发布模式）
   * 当 deployMode 为 'main' 时，会执行以下流程：
   * 1. 当前分支 -> testBranch（测试分支）
   * 2. testBranch -> mainBranch（主分支）
   */
  branches: {
    test: 'test',      // 测试分支名，根据项目实际情况修改
    main: 'main'       // 主分支名，根据项目实际情况修改
  },

  /**
   * 发布模式
   * - 'simple': 简单模式（推荐），直接从当前分支构建部署
   * - 'current': 当前分支发布模式
   */
  deployMode: 'simple',

  /**
   * 服务器配置
   * 可以配置多个服务器环境
   */
  servers: {
    // 生产环境示例
    production: {
      // SSH 连接配置
      sshHost: 'your-server-ip-or-domain',  // 服务器 IP 或域名
      sshUser: 'deployer',                   // SSH 用户名
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`, // SSH 私钥路径

      // 部署配置
      deployUrl: 'https://your-domain.com',  // 部署后的访问地址
      backupDir: '/www/wwwroot/backups/your-app',  // 备份目录
      deployDir: '/www/wwwroot/your-app',    // 部署目录
      backupPrefix: 'backup-production',     // 备份文件前缀

      // 构建配置
      buildMode: 'production',               // 构建模式：production 或 test
      buildCommand: 'yarn build',            // 自定义构建命令（可选，默认根据 buildMode 自动选择）

      // 需要保护的目录（部署时不会被删除）
      protectedDirs: ['webgl', 'uploads'],   // 例如：webgl、uploads 等静态资源目录

      // 传输模式（可选）: 'pipe' | 'sftp' | 'obs' (OBS中转) | 'git' (Git分支部署)
      // transferMode: 'pipe',

      // Git Release 分支部署（可选）
      // 在同一仓库创建独立 release 分支，存放构建产物压缩包
      // gitRelease: {
      //   branch: 'release'    // 分支名，默认 'release'
      // },

      // 华为云 OBS 中转部署（可选）
      // 配置后优先将构建产物上传到 OBS，服务器通过内网拉取，避免公网直传不稳定
      // obsConfig: {
      //   bucket: 'your-bucket',                                  // OBS 桶名
      //   endpoint: 'obs.cn-north-4.myhuaweicloud.com',           // OBS 公网 Endpoint
      //   internalEndpoint: 'obs.cn-north-4.myhuaweicloud.com',   // 内网 Endpoint（可选，服务器拉取用）
      //   accessKeyId: 'your-ak',                                 // 访问密钥 ID
      //   secretAccessKey: 'your-sk',                             // 访问密钥
      //   uploadDir: 'deploy/your-app',                            // OBS 对象前缀（可选）
      // },
    },

    // 测试环境示例
    test: {
      sshHost: 'test-server-ip',
      sshUser: 'deployer',
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`,
      deployUrl: 'https://test.your-domain.com',
      backupDir: '/www/wwwroot/backups/test-app',
      deployDir: '/www/wwwroot/test-app',
      backupPrefix: 'backup-test',
      buildMode: 'test',
      protectedDirs: ['webgl']
    }
  },

  /**
   * 备份保留数量（可选）
   * 默认保留最新的 1 个备份
   */
  backupRetentionCount: 1,

  /**
   * 钉钉通知配置（可选）
   * 部署完成后自动发送钉钉消息通知
   */
  dingtalk: {
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=your-token', // 钉钉机器人 webhook URL
    enabled: true,  // 是否启用钉钉通知，默认 true
    keyword: '部署'  // 安全设置关键词（如果机器人设置了关键词，必须配置此项）
  },

  /**
   * 日志配置（可选）
   * 部署日志存储目录，默认项目根目录下的 logs 目录
   */
  logDir: 'logs',

  /**
   * 是否启用备份下载（可选）
   * 部署完成后是否自动从服务器下载备份到本地，默认 true
   */
  enableBackupDownload: true,

  /**
   * 本地备份目录（可选）
   * 线上备份下载到本地的存储目录
   * 保留 7 天内的备份，自动清理旧备份
   * 仅当 enableBackupDownload 为 true 时生效
   */
  localBackupDir: path.join(os.homedir(), 'fe-build-backups')
};