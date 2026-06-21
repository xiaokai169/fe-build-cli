# fe-build-cli

前端项目打包部署 CLI 工具，支持多服务器部署、Git 分支管理、回滚等功能。

## 功能特性

- ✅ 一键发布：`fe-build deploy production --yes` 跳过所有交互
- ✅ 项目初始化：`fe-build init` 交互式引导创建配置，自动检测框架/分支/包管理器
- ✅ 环境预检：`fe-build check` 部署前检查本地+远程环境（SSH连通性/磁盘空间/目录权限）
- ✅ 四级发布模式：simple / current / test / main
- ✅ tar 管道流直传（压缩→传输→解压流水线，rsync → pipe → SFTP 三级降级）
- ✅ Git 分支自动合并流程
- ✅ 智能处理本地改动（自动提交或 stash 储藏）
- ✅ 自动备份与回滚（服务器+本地双备份）
- ✅ 配置校验（自动检测配置错误，友好错误提示）
- ✅ 钉钉通知（成功/失败）
- ✅ 保护目录（部署时不删除指定目录）
- ✅ 详细日志记录 + TypeScript 类型支持

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

### 1. 初始化项目配置

```bash
fe-build init
```

交互式引导创建 `fe-build.config.js`，自动检测：
- 项目框架（Vue/React/Angular）
- Git 分支（test/main 或 develop/master）
- 包管理器（yarn/npm/pnpm）
- 构建命令

### 2. 检查环境就绪

```bash
fe-build check production
```

部署前检查本地和远程环境，确保万无一失。

### 3. 一键部署

```bash
# 一键发布到生产环境
fe-build deploy production --yes

# 交互式部署
fe-build
```

### 配置文件示例

```javascript
import process from 'node:process';

export default {
  // 分支配置
  branches: {
    test: 'test',
    main: 'main'
  },

  // 发布模式: 'simple' (推荐) | 'current' | 'test' | 'main'
  deployMode: 'simple',

  // 服务器配置
  servers: {
    production: {
      sshHost: 'your-server.com',
      sshUser: 'deployer',
      sshPort: 22,
      sshKeyPath: `${process.env.USERPROFILE || process.env.HOME}/.ssh/id_rsa`,
      deployUrl: 'https://your-domain.com',
      backupDir: '/www/backups/your-app',
      deployDir: '/www/your-app',
      backupPrefix: 'backup-production',
      buildMode: 'production',
      buildCommand: 'yarn build',
      protectedDirs: ['webgl', 'uploads']
    }
  }
};
```

> 也可以通过 `--config` 参数指定配置文件路径：`fe-build --config ./custom-config.js`

## 命令说明

### init（初始化）

```bash
fe-build init
```

交互式引导创建 `fe-build.config.js`：
- 自动检测项目框架（Vue/React/Angular）
- 自动检测 Git 分支名
- 自动检测包管理器（yarn/npm/pnpm）和构建命令
- 可选配置测试服务器和钉钉通知
- 生成后提示传输模式

### check（环境检查）

```bash
fe-build check [环境]
```

部署前全量预检，不实际部署：

| 检查项 | 说明 |
|--------|------|
| 配置校验 | 必填字段、路径格式、密钥存在性 |
| Git 状态 | 工作区是否干净、当前分支 |
| Node 版本 | >= 18.0.0 |
| SSH 连通性 | 服务器可达性、认证有效性 |
| 服务器磁盘 | 使用率、可用空间 |
| 目录权限 | 部署目录和备份目录是否可写 |
| rsync | 本地和服务器 rsync 可用性 |

输出：✅ 通过 / ⚠️ 警告 / ❌ 阻断

### deploy（部署）

```bash
fe-build [deploy] [环境] [选项]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称（如 production、test），或 `all` 部署到所有环境 |
| `--yes`, `-y` | **一键模式** — 跳过所有交互确认，使用默认行为 |
| `--skip-check` | 跳过部署前环境预检 |
| `--config <路径>` | 指定配置文件路径 |
| `--current-branch` | 使用当前分支发布（不切换分支） |
| `--test-branch` | 使用 Test 环境发布流程（智能处理本地改动） |
| `--merge` | Test 发布时合并本地改动 |
| `--no-merge` | Test 发布时使用 stash 储藏改动 |
| `--main-branch` | 使用主分支发布流程 |
| `--skip-build` | 跳过构建步骤 |
| `--no-push` | 发布时不推送到远程 |

**传输方式（三级降级）：**

```
1. rsync 增量同步    ← 有 rsync 时优先（只传变更文件）
   ↓ 失败降级
2. tar 管道流直传    ← Windows→Linux 推荐（压缩→传输→解压流水线）
   ↓ 失败降级
3. SFTP 上传         ← 兜底（ssh2 库 fastPut）
```

**示例：**

```bash
# 一键部署（推荐）
fe-build deploy production --yes

# 交互式部署
fe-build

# 部署到指定环境
fe-build deploy production

# 部署到所有环境
fe-build deploy all --yes

# 跳过预检紧急部署
fe-build deploy production --yes --skip-check

# 当前分支发布
fe-build --current-branch

# Test 环境发布
fe-build --test-branch --merge

# 主分支发布流程
fe-build --main-branch

# 指定配置文件
fe-build --config ./custom-config.js production --yes
```

### rollback（回滚）

```bash
fe-build rollback [环境] [选项]
```

| 参数 | 说明 |
|------|------|
| `环境` | 目标环境名称 |
| `--yes`, `-y` | 一键模式 — 自动选择最新服务器备份 |
| `--server` | 使用服务器备份（默认） |
| `--local` | 使用本地备份 |
| `--version <版本号>` | 指定回滚版本 |

**示例：**

```bash
# 一键回滚（自动选最新备份）
fe-build rollback production --yes

# 交互式回滚
fe-build rollback production

# 指定备份来源
fe-build rollback production --server
fe-build rollback production --local

# 指定版本
fe-build rollback production --version build-20240101-abc123
```

### update（更新）

```bash
fe-build update [--force]
fe-build check-update
fe-build version
fe-build help
```

## 发布模式详解

### Simple 简单发布模式（推荐）

流程：当前分支 → 直接构建部署

```
┌─────────────┐     ┌─────────────┐
│  当前分支   │ ──► │    部署     │
└─────────────┘     └─────────────┘
```

**适用场景：** 个人项目、小团队、快速迭代。不做任何分支切换和合并。

**执行步骤：**
1. 检查工作区（有改动仅警告不阻断）
2. 拉取最新代码
3. 执行构建和部署

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

  // 发布模式: 'simple' (推荐) | 'current' | 'test' | 'main'
  deployMode: 'simple',

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

### 传输模式

| 模式 | 原理 | 速度 | 触发条件 |
|------|------|------|---------|
| rsync 增量同步 | `rsync dist/ → 服务器镜像目录`，只传变更文件 | ⭐⭐⭐ | 本地有 rsync |
| tar 管道流直传 | `tar czf - dist/ \| ssh tar xzf -`，流水线并行 | ⭐⭐⭐ | 默认 |
| SFTP 上传 | ssh2 库 `fastPut` 全量上传 tar.gz | ⭐⭐ | 前两种失败时 |

### 部署步骤

```
[步骤 1/7] 构建项目
[步骤 2/7] 验证构建输出
[步骤 3/7] 备份现有部署
[步骤 4/7] 流式传输 dist/ → 服务器
[步骤 5/7] 部署到目标目录
[步骤 6/7] 清理临时文件
[步骤 7/7] 完成
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
  executeSimpleFlow,
  executeMainBranchFlow,
  executeCurrentBranchFlow,
  executeTestBranchFlow,
  runPreflightChecks,
  runInit,
  validateConfig,
  SSHClient
} from 'fe-build-cli';

// 初始化项目配置
await runInit({ cwd: process.cwd() });

// 环境预检
const { canDeploy, results } = await runPreflightChecks({
  environment: 'production',
  envConfig: serverConfig,
  config: fullConfig
});

// 校验配置
const { valid, errors } = validateConfig(config);

// 部署到服务器
await deployToServer({
  environment: 'production',
  envConfig: serverConfig,
  buildVersion: 'build-20240101-abc123'
});

// 简单发布（推荐）
const result = executeSimpleFlow(logger);

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

### 1. 如何快速开始？

```bash
fe-build init           # 初始化配置
fe-build check production  # 检查环境
fe-build deploy production --yes  # 一键发布
```

### 2. 传输很慢怎么办？

工具已内置三级降级，优先使用最快的：
- **rsync**：仅传变更文件，安装 Git for Windows 自带
- **管道流**：默认方案，压缩→传输→解压流水线
- **SFTP**：兜底方案

### 3. SSH 连接失败

先用预检排查：`fe-build check production`

常见原因：
- SSH 私钥路径是否正确
- 服务器端口是否开放
- 用户是否有部署目录写入权限

### 4. 分支合并冲突

主分支发布模式下冲突时：
- 工具自动中止合并
- 手动解决冲突后重新执行

### 5. 如何跳过交互？

所有命令都支持 `--yes` / `-y`：
```bash
fe-build deploy production --yes
fe-build rollback production --yes
```

## 版本要求

- Node.js >= 18.0.0
- 支持 ES Module

## License

MIT