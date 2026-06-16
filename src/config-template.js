import process from 'node:process';

/**
 * fe-build-cli 配置文件模板
 * 将此文件复制到项目根目录并重命名为 fe-build.config.js
 */

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
   * - 'main': 主分支发布模式（默认）
   *   流程：当前分支 -> 测试分支 -> 主分支，然后从主分支发布
   * - 'current': 当前分支发布模式
   *   直接从当前分支发布，不切换分支
   */
  deployMode: 'main',

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
      protectedDirs: ['webgl', 'uploads']    // 例如：webgl、uploads 等静态资源目录
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
  }
};