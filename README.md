# fe-build-cli

前端项目打包部署 CLI 工具，支持多服务器部署、回滚、钉钉通知、备份下载等功能。

## 功能特性

- ✅ **一键部署**：`fe-build deploy production --yes` 跳过所有交互
- ✅ **项目初始化**：`fe-build init` 交互式引导创建配置，自动检测框架/分支/包管理器
- ✅ **环境预检**：`fe-build check` 部署前检查本地+远程环境（SSH连通性/磁盘空间/目录权限）
- ✅ **tar 管道流直传**：压缩→传输→解压流水线并行，失败自动降级 SFTP
- ✅ **自动备份与回滚**：服务器+本地双备份，支持交互选择和指定版本
- ✅ **原子替换部署**：零空窗期切换，避免部署过程中的 403 问题
- ✅ **配置校验**：自动检测配置错误，友好错误提示
- ✅ **钉钉通知**：部署成功/失败/回滚自动通知
- ✅ **保护目录**：部署时不删除指定目录（WebGL、uploads 等）
- ✅ **详细日志**：每步操作全量记录，失败时单独保存错误日志
- ✅ **跨平台**：Windows / macOS / Linux 全兼容
- ✅ **TypeScript 类型支持**

## 安装

```bash
npm install -g fe-build-cli
```

## 快速开始

### 1. 初始化项目配置

```bash
fe-build init
```

交互式引导创建 `fe-build.config.js`，自动检测：
- 项目框架（Vue/React/Angular）
- Git 分支
- 包管理器（yarn/npm/pnpm）
- 构建命令

### 2. 检查环境

```bash
fe-build check production
```

### 3. 一键部署

```bash
fe-build deploy production --yes
```

## 命令说明

### init — 初始化配置

```bash
fe-build init
```

交互式引导创建 `fe-build.config.js`，覆盖以下内容：
- 分支名（自动从 Git 推断）
- 发布模式（simple / current）
- 生产服务器配置（SSH、部署路径、构建命令）
- 测试服务器配置（可选）
- 钉钉通知（可选）
- 本地备份下载（可选）

### check — 环境预检

```bash
fe-build check [环境]
```

| 检查项 | 说明 |
|--------|------|
| 配置校验 | 必填字段、路径格式、SSH 密钥存在性 |
| Node.js 版本 | >= 18.0.0 |
| Git 可用性 | git 命令是否可用 |
| Git 工作区 | 是否有未提交改动（仅警告） |
| 本地磁盘空间 | 可用空间和使用率 |
| 本地 SSH 命令 | ssh 命令是否可用（管道流需要） |
| SSH 连通性 | 服务器可达、认证有效 |
| 服务器磁盘空间 | 使用率和可用空间 |
| 服务器目录权限 | 部署目录和备份目录是否可写 |

### deploy — 部署

```bash
fe-build [deploy] [环境] [选项]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称（production / test），或 `all` 全部部署 |
| `--yes`, `-y` | 一键模式，跳过所有交互确认 |
| `--skip-build` | 跳过构建步骤（使用已有 dist） |
| `--skip-check` | 跳过部署前环境预检 |
| `--config <路径>` | 指定配置文件路径 |

**传输方式（两级降级）：**

```
1. tar 管道流直传    ← 默认（压缩→传输→解压流水线并行，零临时文件）
   ↓ 失败降级
2. SFTP 上传         ← 兜底（ssh2 库 fastPut 全量上传）
```

**示例：**

```bash
# 一键部署（推荐）
fe-build deploy production --yes

# 交互式部署
fe-build

# 部署到所有环境
fe-build deploy all --yes

# 跳过预检紧急部署
fe-build deploy production --yes --skip-check

# 跳过构建（使用已有 dist 目录）
fe-build deploy production --yes --skip-build

# 指定配置文件
fe-build --config ./custom-config.js production --yes
```

### rollback — 回滚

```bash
fe-build rollback [环境] [选项]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称 |
| `--yes`, `-y` | 一键模式，自动选最新备份 |
| `--server` | 使用服务器备份（默认） |
| `--local` | 使用本地备份 |
| `--version <版本号>` | 指定回滚版本 |

**示例：**

```bash
# 一键回滚（自动选最新服务器备份）
fe-build rollback production --yes

# 交互式回滚（选择备份来源和版本）
fe-build rollback production

# 使用本地备份
fe-build rollback production --local

# 指定版本回滚
fe-build rollback production --version build-20240101-abc123
```

### update — 更新 CLI 工具

```bash
fe-build update              # 交互式更新
fe-build update --force      # 自动更新
fe-build check-update        # 仅检查新版本
fe-build version             # 显示当前版本
fe-build help                # 显示帮助
```

## 发布模式

只保留两种模式，去掉了 Git 分支自动合并编排：

### Simple 模式（推荐）

直接从当前分支构建 → 部署。不做任何 Git 操作。

```
当前分支 → 构建 → 部署
```

### Current 模式

与 Simple 相同，仅输出分支信息不同。

```
当前分支 → 构建 → 部署
```

> **设计理念**：Git 分支管理交给开发者自己控制，CLI 工具只负责"构建 + 传输 + 部署"这一核心链路。

## 配置文件

### 完整示例

```javascript
import os from 'node:os';
import path from 'node:path';

export default {
  // 发布模式: 'simple' (推荐) | 'current'
  deployMode: 'simple',

  // 服务器配置
  servers: {
    production: {
      sshHost: 'your-server.com',
      sshUser: 'deployer',
      sshPort: 22,
      sshKeyPath: path.join(os.homedir(), '.ssh', 'id_rsa'),

      // 部署路径
      deployUrl: 'https://your-domain.com',
      backupDir: '/www/backups/your-app',
      deployDir: '/www/wwwroot/your-app',
      backupPrefix: 'backup-production',

      // 构建配置
      buildMode: 'production',
      buildCommand: 'yarn build',

      // 保护目录（部署时不删除）
      protectedDirs: ['webgl', 'uploads']
    },

    // 测试环境（可选）
    test: {
      sshHost: 'test-server.com',
      sshUser: 'deployer',
      sshPort: 22,
      sshKeyPath: path.join(os.homedir(), '.ssh', 'id_rsa'),
      deployUrl: 'https://test.your-domain.com',
      backupDir: '/www/backups/test-app',
      deployDir: '/www/wwwroot/test-app',
      backupPrefix: 'backup-test',
      buildMode: 'test',
      buildCommand: 'yarn build:test',
      protectedDirs: ['webgl']
    }
  },

  // 备份保留数量（默认 1）
  backupRetentionCount: 1,

  // 日志目录
  logDir: 'logs',

  // 备份下载到本地
  enableBackupDownload: true,
  localBackupDir: path.join(os.homedir(), 'fe-build-backups'),

  // 钉钉通知（可选）
  dingtalk: {
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=your-token',
    enabled: true,
    keyword: '部署'
  }
};
```

### 配置项一览

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `deployMode` | `'simple' \| 'current'` | 否 | 发布模式，默认 `simple` |
| `servers` | object | 是 | 服务器配置，key 为环境名 |
| `servers[key].sshHost` | string | 是 | 服务器 IP 或域名 |
| `servers[key].sshUser` | string | 是 | SSH 用户名 |
| `servers[key].sshKeyPath` | string | 是 | SSH 私钥路径 |
| `servers[key].sshPort` | number | 否 | SSH 端口，默认 22 |
| `servers[key].deployUrl` | string | 否 | 部署后访问地址（通知用） |
| `servers[key].backupDir` | string | 是 | 备份目录（绝对路径） |
| `servers[key].deployDir` | string | 是 | 部署目录（绝对路径） |
| `servers[key].backupPrefix` | string | 是 | 备份文件前缀 |
| `servers[key].buildMode` | string | 否 | 构建模式，默认 `production` |
| `servers[key].buildCommand` | string | 否 | 自定义构建命令 |
| `servers[key].protectedDirs` | string[] | 否 | 部署时保留的目录 |
| `servers[key].backupRetentionCount` | number | 否 | 备份保留数量，默认 1 |
| `backupRetentionCount` | number | 否 | 全局备份保留数量 |
| `logDir` | string | 否 | 日志目录，默认 `logs` |
| `enableBackupDownload` | boolean | 否 | 是否下载备份到本地，默认 true |
| `localBackupDir` | string | 否 | 本地备份目录，默认 `~/fe-build-backups` |
| `dingtalk.webhook` | string | 否 | 钉钉机器人 webhook URL |
| `dingtalk.enabled` | boolean | 否 | 是否启用钉钉通知 |
| `dingtalk.keyword` | string | 否 | 安全关键词 |

## 部署流程

### 步骤

```
[步骤 1/7] 构建项目
[步骤 2/7] 验证构建输出
[步骤 3/7] 备份现有部署 → 准备临时目录
[步骤 4/7] 流式传输 dist/ → 服务器（tar 管道）
[步骤 5/7] 原子替换部署目录（零空窗期）
[步骤 6/7] 下载线上备份到本地
[步骤 7/7] 完成
```

### 原子替换机制

```
1. 解压/传输到临时目录    (/backup/deploy-tmp/)
2. 备份现有部署            (/backup/backup-xxx.tar.gz)
3. 清理部署目录旧文件
4. mv 临时目录 → 部署目录   （一次操作，零空窗期）
```

### 保护目录

配置 `protectedDirs` 后，部署时这些目录不会被删除：

```javascript
protectedDirs: ['webgl', 'uploads']
```

## 钉钉通知

### 配置

```javascript
dingtalk: {
  webhook: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
  enabled: true,
  keyword: '部署'
}
```

### 通知场景

- **部署成功**：环境、版本、分支、服务器、耗时、修改内容、访问地址
- **部署失败**：错误信息、失败步骤
- **回滚结果**：成功/失败、备份文件

## 日志记录

每次部署自动记录 JSON 格式日志到 `logs/` 目录：

```
logs/
├── deploy-2026-07-02-10-30-45-success.json
├── deploy-2026-07-02-14-20-10-failed.json
└── error-2026-07-02-14-20-10.json
```

| 操作 | 记录内容 |
|------|---------|
| 项目构建 | 模式、版本、耗时 |
| 文件压缩 | 压缩包大小 |
| SSH 连接 | 服务器地址、状态 |
| 文件上传 | 路径、大小、耗时、速度 |
| 服务器备份 | 备份文件路径 |
| 备份下载 | 下载状态 |
| 部署解压 | 部署目录、状态 |
| 钉钉通知 | 发送成功/失败 |

## 线上备份下载

部署完成后自动将服务器备份下载到本地：

```javascript
enableBackupDownload: true,
localBackupDir: path.join(os.homedir(), 'fe-build-backups')
```

本地备份自动保留 7 天，超期自动清理。

## API 使用

```javascript
import {
  deployToServer,
  rollbackDeployment,
  executeSimpleFlow,
  executeCurrentBranchFlow,
  runPreflightChecks,
  runInit,
  validateConfig,
  SSHClient,
  DeployLogger
} from 'fe-build-cli';

// 环境预检
const { canDeploy, results } = await runPreflightChecks({
  environment: 'production',
  envConfig: serverConfig,
  config: fullConfig
});

// 部署到服务器
await deployToServer({
  environment: 'production',
  envConfig: serverConfig,
  buildVersion: 'build-20240101-abc123',
  logger: new DeployLogger({ logDir: 'logs' })
});

// 回滚
await rollbackDeployment({
  environment: 'production',
  envConfig: serverConfig,
  specifiedVersion: 'build-20240101-abc123',
  logger: new DeployLogger({ logDir: 'logs' })
});
```

## 兼容旧项目

已有 `scripts/deploy.config.js` 的项目直接可用，无需迁移：

```bash
fe-build --config ./scripts/deploy.config.js
```

## 版本要求

- Node.js >= 18.0.0
- 需要 `git`、`ssh`、`tar` 命令在 PATH 中

## License

MIT
