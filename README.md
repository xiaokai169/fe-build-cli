# fe-build-cli

前端项目打包部署 CLI 工具，支持多服务器部署、Git 分支管理、回滚等功能。

## 功能特性

- ✅ 多服务器环境部署
- ✅ 两种发布模式：主分支发布 / 当前分支发布
- ✅ Git 分支自动合并流程
- ✅ SSH 远程部署（带进度条）
- ✅ 自动备份与回滚
- ✅ 保护目录（部署时不删除指定目录）
- ✅ TypeScript 类型支持

## 流程图

查看详细的部署流程图：[docs/flow-diagram.html](docs/flow-diagram.html)

流程图包含：
- 主分支发布模式流程
- 当前分支发布模式流程
- 部署详细步骤（8 步）
- 回滚流程

## 安装

```bash
# 全局安装
npm install -g fe-build-cli

# 或在项目中安装
npm install fe-build-cli --save-dev
```

## 快速开始

### 1. 创建配置文件

在项目根目录创建 `fe-build.config.js`：

```javascript
import process from 'node:process';

export default {
  // 分支配置（用于主分支发布模式）
  branches: {
    test: 'test',      // 测试分支名
    main: 'main'       // 主分支名
  },

  // 发布模式：'main'（主分支发布）或 'current'（当前分支发布）
  deployMode: 'main',

  // 服务器配置
  servers: {
    production: {
      sshHost: 'your-server.com',
      sshUser: 'deployer',
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`,
      deployUrl: 'https://your-domain.com',
      backupDir: '/www/backups/your-app',
      deployDir: '/www/your-app',
      backupPrefix: 'backup-production',
      buildMode: 'production',
      protectedDirs: ['webgl', 'uploads']
    },

    test: {
      sshHost: 'test-server.com',
      sshUser: 'deployer',
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`,
      deployUrl: 'https://test.your-domain.com',
      backupDir: '/www/backups/test-app',
      deployDir: '/www/test-app',
      backupPrefix: 'backup-test',
      buildMode: 'test',
      protectedDirs: ['webgl']
    }
  }
};
```

### 2. 执行部署

```bash
# 交互式选择环境部署
fe-build

# 直接部署到指定环境
fe-build deploy production

# 部署到所有环境
fe-build deploy all
```

## 命令说明

### deploy（部署）

```bash
fe-build [deploy] [环境] [选项]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称（如 production、test），或 `all` 部署到所有环境 |
| `--config <路径>` | 指定配置文件路径 |
| `--current-branch` | 使用当前分支发布（不切换分支） |
| `--main-branch` | 使用主分支发布流程 |
| `--skip-build` | 跳过构建步骤 |
| `--no-push` | 主分支发布时不推送到远程 |

**示例：**

```bash
# 交互式部署
fe-build

# 部署到生产环境
fe-build deploy production

# 当前分支发布（不切换分支）
fe-build --current-branch

# 主分支发布流程
fe-build --main-branch

# 跳过构建，仅上传部署
fe-build --skip-build

# 使用指定配置文件
fe-build --config ./custom-config.js
```

### rollback（回滚）

```bash
fe-build rollback [环境] [--version <版本号>]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称 |
| `--version <版本号>` | 指定回滚版本（可选，默认回滚到上一版本） |

**示例：**

```bash
# 回滚生产环境到上一版本
fe-build rollback production

# 回滚到指定版本
fe-build rollback production --version build-20240101-abc123
```

### help（帮助）

```bash
fe-build help
fe-build --help
fe-build -h
```

## 发布模式详解

### 主分支发布模式（默认）

流程：当前分支 → 测试分支 → 主分支 → 部署

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  当前分支   │ ──► │   测试分支  │ ──► │   主分支    │ ──► │    部署     │
│  (feature)  │     │   (test)    │     │   (main)    │     │  (服务器)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

**适用场景：** 正式发布，需要经过测试分支验证

**执行步骤：**
1. 检查工作区是否干净
2. 切换到测试分支，拉取最新代码
3. 合并当前分支到测试分支
4. 推送测试分支到远程
5. 切换到主分支，拉取最新代码
6. 合并测试分支到主分支
7. 推送主分支到远程
8. 执行构建和部署
9. 可选择切回原分支

### 当前分支发布模式

流程：当前分支 → 直接部署

```
┌─────────────┐     ┌─────────────┐
│  当前分支   │ ──► │    部署     │
│  (feature)  │     │  (服务器)   │
└─────────────┘     └─────────────┘
```

**适用场景：** 快速测试、临时发布、开发调试

**执行步骤：**
1. 获取当前分支信息
2. 执行构建和部署（不切换分支）

## 配置文件详解

### 完整配置示例

```javascript
import process from 'node:process';

export default {
  // 分支配置
  branches: {
    test: 'test',      // 测试分支名（必填，主分支模式需要）
    main: 'main'       // 主分支名（必填，主分支模式需要）
  },

  // 发布模式
  deployMode: 'main',  // 'main' 或 'current'

  // 服务器配置
  servers: {
    production: {
      // SSH 连接配置
      sshHost: 'your-server-ip',           // 服务器 IP 或域名（必填）
      sshUser: 'deployer',              // SSH 用户名（必填）
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`, // SSH 私钥路径（必填）
      sshPort: 22,                      // SSH 端口（可选，默认 22）

      // 部署配置
      deployUrl: 'https://www.example.com', // 部署后访问地址（必填）
      backupDir: '/www/backups/example',    // 备份目录（必填）
      deployDir: '/www/example',            // 部署目录（必填）
      backupPrefix: 'backup-production',    // 备份文件前缀（必填）

      // 构建配置
      buildMode: 'production',          // 构建模式：production 或 test
      buildCommand: 'yarn build',       // 自定义构建命令（可选）

      // 保护目录（部署时不删除）
      protectedDirs: ['webgl', 'uploads', 'static']
    }
  },

  // 备份保留数量（可选，默认 1）
  backupRetentionCount: 3,

  // 钉钉通知配置（可选）
  dingtalk: {
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=your-token', // 钉钉机器人 webhook
    enabled: true  // 是否启用通知，默认 true
  }
};
```

### 配置项说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `branches.test` | string | 主分支模式必填 | 测试分支名 |
| `branches.main` | string | 主分支模式必填 | 主分支名 |
| `deployMode` | string | 否 | 发布模式，默认 `main` |
| `servers` | object | 是 | 服务器配置对象 |
| `servers[key].sshHost` | string | 是 | 服务器 IP 或域名 |
| `servers[key].sshUser` | string | 是 | SSH 用户名 |
| `servers[key].sshKeyPath` | string | 是 | SSH 私钥路径 |
| `servers[key].sshPort` | number | 否 | SSH 端口，默认 22 |
| `servers[key].deployUrl` | string | 是 | 部署后访问地址 |
| `servers[key].backupDir` | string | 是 | 备份目录 |
| `servers[key].deployDir` | string | 是 | 部署目录 |
| `servers[key].backupPrefix` | string | 是 | 备份文件前缀 |
| `servers[key].buildMode` | string | 否 | 构建模式，默认 production |
| `servers[key].buildCommand` | string | 否 | 自定义构建命令 |
| `servers[key].protectedDirs` | string[] | 否 | 保护目录列表 |
| `backupRetentionCount` | number | 否 | 备份保留数量，默认 1 |
| `dingtalk.webhook` | string | 否 | 钉钉机器人 webhook URL |
| `dingtalk.enabled` | boolean | 否 | 是否启用通知，默认 true |

## 钉钉通知

部署完成后可自动发送钉钉消息通知，支持以下场景：

- **部署成功通知**：包含环境、版本、分支、服务器、耗时等信息
- **部署失败通知**：包含错误信息，便于快速排查
- **回滚通知**：包含回滚结果和备份文件信息

### 配置钉钉机器人

1. 在钉钉群中添加机器人，获取 webhook URL
2. 在配置文件中添加：

```javascript
dingtalk: {
  webhook: 'https://oapi.dingtalk.com/robot/send?access_token=your-token',
  enabled: true
}
```

### 通知消息示例

部署成功通知：

```
🚀 部署成功通知

环境: production
状态: ✅ 成功
时间: 2024-01-01 10:30:00

构建版本: build-20240101-abc123
发布分支: main
发布模式: 主分支发布
服务器: your-server-ip
部署耗时: 120秒

访问地址: https://www.example.com
```

## 部署流程详解

### 部署步骤（8 步）

```
[步骤 1/8] 构建项目
[步骤 2/8] 验证构建输出
[步骤 3/8] 压缩本地构建产物
[步骤 4/8] 备份现有部署
[步骤 5/8] 上传压缩包
[步骤 6/8] 清理并解压新版本
[步骤 7/8] 删除压缩包
[步骤 8/8] 完成
```

### 保护目录机制

部署时会保护指定的目录不被删除，适用于：
- 大型静态资源（如 WebGL 文件）
- 用户上传文件
- 第三方服务生成的文件

配置示例：
```javascript
protectedDirs: ['webgl', 'uploads', 'static']
```

部署时这些目录会被保留，不会被新版本覆盖。

## API 使用

除了 CLI 命令，也可以作为模块在代码中使用：

```javascript
import {
  deployToServer,
  rollbackDeployment,
  executeMainBranchFlow,
  executeCurrentBranchFlow,
  SSHClient
} from 'fe-build-cli';

// 部署到服务器
await deployToServer({
  environment: 'production',
  envConfig: serverConfig,
  buildVersion: 'build-20240101-abc123'
});

// 执行主分支发布流程
const result = executeMainBranchFlow({
  testBranch: 'test',
  mainBranch: 'main',
  pushToRemote: true
});

// 使用 SSH 客户端
const ssh = new SSHClient(serverConfig);
await ssh.connect();
await ssh.execCommand('ls -la');
await ssh.disconnect();
```

## 兼容旧项目

如果你的项目已有 `scripts/deploy.config.js`，可以直接使用，无需迁移：

```bash
# 自动识别 scripts/deploy.config.js
fe-build
```

## 常见问题

### 1. SSH 连接失败

检查 SSH 配置：
- 确保 SSH 私钥路径正确
- 确保服务器已添加到 known_hosts
- 确保用户有部署目录的写入权限

### 2. 构建失败

检查构建命令：
- 确保 `buildCommand` 配置正确
- 确保项目依赖已安装
- 确保构建脚本可正常执行

### 3. 分支合并冲突

主分支发布模式下，如果合并有冲突：
- 工具会自动中止合并
- 需要手动解决冲突后重新执行

### 4. Windows 路径问题

Windows 下 SSH 私钥路径：
```javascript
sshKeyPath: `${process.env.USERPROFILE}/.ssh/id_rsa`
```

## 版本要求

- Node.js >= 18.0.0
- 支持 ES Module

## License

MIT