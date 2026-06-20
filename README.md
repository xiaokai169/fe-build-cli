# fe-build-cli

前端项目打包部署 CLI 工具，支持多服务器部署、Git 分支管理、回滚等功能。

## 功能特性

- ✅ 多服务器环境部署
- ✅ 三种发布模式：主分支发布 / 当前分支发布 / Test 环境发布
- ✅ Git 分支自动合并流程
- ✅ 智能处理本地改动（自动提交或 stash 储藏）
- ✅ SSH 远程部署（带进度条）
- ✅ 自动备份与回滚
- ✅ 线上备份下载到本地（保留 7 天）
- ✅ 详细日志记录（每一步操作及状态）
- ✅ 错误日志单独保存
- ✅ 钉钉通知（成功/失败）
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
| `--test-branch` | 使用 Test 环境发布流程（智能处理本地改动） |
| `--merge` | Test 发布时合并本地改动 |
| `--no-merge` | Test 发布时使用 stash 储藏改动 |
| `--main-branch` | 使用主分支发布流程 |
| `--skip-build` | 跳过构建步骤 |
| `--no-push` | 发布时不推送到远程 |

**示例：**

```bash
# 交互式部署
fe-build

# 部署到生产环境
fe-build deploy production

# 当前分支发布（不切换分支）
fe-build --current-branch

# Test 环境发布（智能处理本地改动）
fe-build --test-branch

# Test 发布，合并本地改动
fe-build --test-branch --merge

# Test 发布，stash 储藏改动
fe-build --test-branch --no-merge

# 主分支发布流程
fe-build --main-branch

# 跳过构建，仅上传部署
fe-build --skip-build

# 使用指定配置文件
fe-build --config ./custom-config.js
```

### rollback（回滚）

```bash
fe-build rollback [环境] [--server|--local] [--version <版本号>]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称 |
| `--server` | 使用服务器备份（默认） |
| `--local` | 使用本地备份 |
| `--version <版本号>` | 指定回滚版本（可选） |

**回滚流程：**

1. 获取备份列表（服务器和本地）
2. 选择备份来源（默认服务器）
3. 从备份列表中选择要回滚的版本
4. 执行回滚

**示例：**

```bash
# 回滚生产环境（交互选择备份来源和版本）
fe-build rollback production

# 回滚生产环境（使用服务器备份）
fe-build rollback production --server

# 回滚生产环境（使用本地备份）
fe-build rollback production --local

# 回滚到指定版本
fe-build rollback production --version build-20240101-abc123
```

**备份列表显示：**

```
========================================
  📦 选择备份来源
========================================
  1. 服务器备份 (5 个) - 默认
  2. 本地备份 (3 个)
========================================
请选择备份来源 (1/2): 1

========================================
  📦 服务器备份列表
========================================
  1. 20260618-abc123 (12.5 MB) - 2026/6/18
  2. 20260617-def456 (11.8 MB) - 2026/6/17
  3. 20260616-ghi789 (10.2 MB) - 2026/6/16
========================================
请选择要回滚的备份 (1-3): 
```

### update（更新）

```bash
fe-build update [--force|--auto]
fe-build check-update
```

| 参数 | 说明 |
|------|------|
| `--force` | 自动更新，无需确认 |
| `--auto` | 自动更新，无需确认（同 --force） |

**功能说明：**

- `update` - 检查并更新到最新版本（交互确认）
- `update --force` - 自动更新，无需确认
- `check-update` - 仅检查是否有新版本

**示例：**

```bash
# 检查并更新（需要确认）
fe-build update

# 自动更新（无需确认）
fe-build update --force
fe-build update --auto

# 仅检查是否有更新
fe-build check-update

# 手动更新（推荐）
npm update fe-build-cli --global
```

**更新输出示例：**

```
========================================
  🔄 fe-build-cli 版本检查
========================================
当前版本: 1.5.0
最新版本: 1.6.0

📌 发现新版本!

更新方法:
  fe-build update          # 自动更新
  npm update fe-build-cli --global  # 手动更新
========================================
```

### version（版本）

```bash
fe-build version
fe-build --version
fe-build -v
```

显示当前安装的版本号。

### help（帮助）

```bash
fe-build help
fe-build --help
fe-build -h
```

## 发布模式详解

### 主分支发布模式

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
9. 自动切回原分支

### Test 环境发布模式（智能处理本地改动）

流程：智能处理本地改动 → Test 分支 → 部署

**适用场景：** 发布到 Test 环境，自动处理本地未提交的改动

**智能处理策略：**

| 情况 | 处理方式 |
|------|---------|
| 当前已在 test 分支 | 直接拉取最新代码，无需切换 |
| 当前分支 ≠ test，无本地改动 | 直接切换到 test 分支发布 |
| 当前分支 ≠ test，有本地改动 | 选择合并或 stash |

**有本地改动时的选项：**

1. **合并改动**（`--merge`）：
   - 自动提交当前分支改动
   - 推送当前分支到远程
   - 切换到 test 分支
   - 合并当前分支到 test
   - 推送 test 分支
   - 部署完成后自动切回原分支

2. **Stash 储藏**（`--no-merge`）：
   - 储藏本地改动
   - 切换到 test 分支发布
   - 部署完成后询问是否切回原分支
   - 切回后自动恢复 stash

**示例：**
```bash
# Test 环境发布（交互选择处理方式）
fe-build --test-branch

# Test 发布，合并本地改动
fe-build --test-branch --merge

# Test 发布，stash 储藏改动
fe-build --test-branch --no-merge
```

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

  // 日志配置（可选）
  logDir: 'logs',           // 日志目录，默认 'logs'
  localBackupDir: 'D:\\备份', // 本地备份目录，默认 'D:\备份'

  // 钉钉通知配置（可选）
  dingtalk: {
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=your-token', // 钉钉机器人 webhook
    keyword: '部署',         // 安全设置关键词（可选）
    enabled: true            // 是否启用通知，默认 true
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
| `logDir` | string | 否 | 日志目录，默认 'logs' |
| `localBackupDir` | string | 否 | 本地备份目录，默认 'D:\备份' |
| `dingtalk.webhook` | string | 否 | 钉钉机器人 webhook URL |
| `dingtalk.keyword` | string | 否 | 安全设置关键词 |
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
时间: 2026/06/18 10:30:00

---

### 部署详情

构建版本: build-20260618-abc123
发布分支: main
发布模式: 主分支发布
服务器: your-server.com
部署耗时: 120秒

---

### 本次修改内容

feat: 新增用户管理模块

---

### 访问地址

https://www.example.com

> 部署完成，请及时验证功能是否正常。
```

部署失败通知：

```
❌ 部署失败通知

环境: production
状态: ❌ 失败
时间: 2026/06/18 10:30:00

---

### 失败详情

构建版本: build-20260618-abc123
发布分支: main
服务器: your-server.com

---

### 本次修改内容

feat: 新增用户管理模块

---

### 错误信息

SSH 连接失败: Connection refused

> 请及时排查问题并重新部署。
```

## 日志记录

每次部署都会自动记录详细的操作日志，包括每一步的执行状态。

### 日志内容

日志记录以下操作：

| 操作类型 | 记录内容 |
|---------|---------|
| 分支操作 | 切换分支（从哪个分支切换到哪个分支） |
| 代码合并 | 源分支→目标分支，是否有冲突 |
| Stash 操作 | 储藏/恢复本地改动 |
| 项目构建 | 构建模式、版本号、耗时 |
| 文件压缩 | 压缩包大小 |
| SSH 连接 | 服务器地址、连接状态 |
| 文件上传 | 本地路径、远程路径、大小、耗时、速度 |
| 备份操作 | 服务器备份/本地下载 |
| 部署解压 | 部署目录 |
| 钉钉通知 | 发送成功/失败 |

### 日志文件

**存储位置**：`logs` 目录（可通过 `logDir` 配置）

**文件格式**：
```
deploy-2026-06-18-10-30-45-success.json  # 成功日志
deploy-2026-06-18-10-30-45-failed.json   # 失败日志
error-2026-06-18-10-30-45.json           # 错误日志（单独保存）
```

**日志内容示例**：
```json
{
  "summary": {
    "startTime": "2026/06/18 10:30:45",
    "endTime": "2026/06/18 10:35:20",
    "duration": 275,
    "status": "success",
    "totalSteps": 15,
    "successSteps": 15,
    "failedSteps": 0
  },
  "logs": [
    {
      "timestamp": "2026/06/18 10:30:45",
      "level": "SUCCESS",
      "step": "分支操作",
      "message": "切换分支: feature-xxx → test, 成功",
      "data": { "action": "切换分支", "fromBranch": "feature-xxx", "toBranch": "test" }
    }
    // ... 更多日志
  ]
}
```

### 错误日志

部署失败时，错误日志会单独保存一份，便于快速定位问题：
- 包含完整的错误信息
- 包含所有操作日志
- 文件名以 `error-` 开头

## 线上备份下载

部署完成后，线上备份会自动下载到本地保存。

### 配置

```javascript
// 本地备份目录（默认：D:\备份）
localBackupDir: 'D:\\备份'
```

### 自动清理

本地备份自动保留 **7 天**，超过 7 天的备份文件会被自动清理。

### 备份文件命名

```
backup-production-build-20260618-abc123.tar.gz
backup-test-build-20260618-def456.tar.gz
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