/**
 * fe-build-cli 类型定义
 */

/**
 * 服务器配置
 */
export interface ServerConfig {
  /** SSH 服务器地址 */
  sshHost: string;
  /** SSH 用户名 */
  sshUser: string;
  /** SSH 私钥路径 */
  sshKeyPath: string;
  /** SSH 端口（默认 22） */
  sshPort?: number;
  /** 部署后的访问地址 */
  deployUrl: string;
  /** 备份目录 */
  backupDir: string;
  /** 部署目录 */
  deployDir: string;
  /** 备份文件前缀 */
  backupPrefix: string;
  /** 构建模式：production 或 test */
  buildMode?: 'production' | 'test';
  /** 自定义构建命令 */
  buildCommand?: string;
  /** 需要保护的目录（部署时不会被删除） */
  protectedDirs?: string[];
}

/**
 * 分支配置
 */
export interface BranchesConfig {
  /** 测试分支名 */
  test: string;
  /** 主分支名 */
  main: string;
}

/**
 * 钉钉通知配置
 */
export interface DingtalkConfig {
  /** 钉钉机器人 webhook URL */
  webhook: string;
  /** 是否启用钉钉通知，默认 true */
  enabled?: boolean;
  /** 安全设置关键词（如果机器人设置了关键词，必须配置此项） */
  keyword?: string;
}

/**
 * fe-build-cli 配置
 */
export interface FeBuildConfig {
  /** 分支配置 */
  branches?: BranchesConfig;
  /** 发布模式：main（主分支发布）或 current（当前分支发布） */
  deployMode?: 'main' | 'current';
  /** 钉钉通知配置 */
  dingtalk?: DingtalkConfig;
  /** 服务器配置 */
  servers: Record<string, ServerConfig>;
  /** 备份保留数量 */
  backupRetentionCount?: number;
  /** 日志目录 */
  logDir?: string;
  /** 是否启用备份下载，默认 true */
  enableBackupDownload?: boolean;
  /** 本地备份目录 */
  localBackupDir?: string;
}

/**
 * 部署选项
 */
export interface DeployOptions {
  /** 环境名称 */
  environment: string;
  /** 环境配置 */
  envConfig: ServerConfig;
  /** 构建版本 */
  buildVersion: string;
  /** 是否跳过构建 */
  skipBuild?: boolean;
  /** 是否跳过本地清理 */
  skipLocalCleanup?: boolean;
  /** 本地备份目录 */
  localBackupDir?: string;
  /** 是否启用备份下载 */
  enableBackupDownload?: boolean;
}

/**
 * 回滚选项
 */
export interface RollbackOptions {
  /** 环境名称 */
  environment: string;
  /** 环境配置 */
  envConfig: ServerConfig;
  /** 指定版本（可选） */
  specifiedVersion?: string;
}

/**
 * 主分支发布流程选项
 */
export interface MainBranchFlowOptions {
  /** 测试分支名 */
  testBranch: string;
  /** 主分支名 */
  mainBranch: string;
  /** 是否推送到远程 */
  pushToRemote?: boolean;
}

/**
 * 分支流程执行结果
 */
export interface BranchFlowResult {
  /** 是否成功 */
  success: boolean;
  /** 原始分支 */
  originalBranch: string;
  /** 当前分支 */
  currentBranch: string;
  /** 测试分支（主分支模式） */
  testBranch?: string;
  /** 主分支（主分支模式） */
  mainBranch?: string;
  /** Git SHA（当前分支模式） */
  gitSha?: string;
}

/**
 * SSH 客户端类
 */
export class SSHClient {
  constructor(config: ServerConfig);
  connect(): Promise<void>;
  execCommand(command: string): Promise<string>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * 部署函数
 */
export function deployToServer(options: DeployOptions): Promise<void>;

/**
 * 回滚函数
 */
export function rollbackDeployment(options: RollbackOptions): Promise<void>;

/**
 * 构建项目
 */
export function buildProject(envConfig: ServerConfig, buildVersion: string): void;

/**
 * 验证构建输出
 */
export function verifyBuildOutput(skipBuild: boolean): void;

/**
 * 压缩构建产物
 */
export function compressBuild(localZipFile: string, skipBuild: boolean): void;

/**
 * 备份现有部署
 */
export function backupExistingDeployment(options: {
  ssh: SSHClient;
  envConfig: ServerConfig;
  buildVersion: string;
  skipBuild: boolean;
}): Promise<void>;

/**
 * 上传构建产物
 */
export function uploadBuild(
  ssh: SSHClient,
  localZipFile: string,
  remoteZipFile: string,
  skipBuild: boolean
): Promise<void>;

/**
 * 清理部署目录并解压新版本
 */
export function deployAndExtract(options: {
  ssh: SSHClient;
  envConfig: ServerConfig;
  remoteZipFile: string;
  skipBuild: boolean;
}): Promise<void>;

/**
 * 清理临时文件
 */
export function cleanupFiles(options: {
  ssh: SSHClient;
  remoteZipFile: string;
  localZipFile: string;
  skipLocalCleanup: boolean;
  skipBuild: boolean;
}): Promise<void>;

/**
 * 获取当前 Git 分支名称
 */
export function getCurrentBranch(): string;

/**
 * 获取 Git 提交 SHA（短格式）
 */
export function getGitSha(): string;

/**
 * 检查工作区是否干净
 */
export function isWorkingTreeClean(): boolean;

/**
 * 检查是否有未提交的更改
 */
export function checkUncommittedChanges(): { clean: boolean; changes: string[] };

/**
 * 切换到指定分支
 */
export function checkoutBranch(branchName: string): void;

/**
 * 拉取远程分支最新代码
 */
export function pullBranch(branchName: string): void;

/**
 * 合并分支
 */
export function mergeBranch(sourceBranch: string, targetBranch: string): boolean;

/**
 * 推送分支到远程
 */
export function pushBranch(branchName: string): void;

/**
 * 执行主分支发布流程
 */
export function executeMainBranchFlow(config: MainBranchFlowOptions): BranchFlowResult;

/**
 * 执行当前分支发布流程
 */
export function executeCurrentBranchFlow(): BranchFlowResult;

/**
 * 发布后切回原分支
 */
export function restoreBranch(originalBranch: string): void;

/**
 * 钉钉通知结果
 */
export interface DingtalkResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * 部署成功通知选项
 */
export interface DeploySuccessNotificationOptions {
  environment: string;
  buildVersion: string;
  serverHost: string;
  deployUrl: string;
  branch: string;
  deployMode: string;
  duration?: string;
}

/**
 * 部署失败通知选项
 */
export interface DeployFailureNotificationOptions {
  environment: string;
  buildVersion?: string;
  serverHost: string;
  branch: string;
  error: string;
}

/**
 * 回滚通知选项
 */
export interface RollbackNotificationOptions {
  environment: string;
  backupFile: string;
  serverHost: string;
  deployUrl: string;
  success: boolean;
}

/**
 * 发送钉钉消息
 */
export function sendDingTalkMessage(webhookUrl: string, message: any): Promise<DingtalkResult>;

/**
 * 发送部署成功通知
 */
export function sendDeploySuccessNotification(
  webhookUrl: string,
  options: DeploySuccessNotificationOptions
): Promise<DingtalkResult>;

/**
 * 发送部署失败通知
 */
export function sendDeployFailureNotification(
  webhookUrl: string,
  options: DeployFailureNotificationOptions
): Promise<DingtalkResult>;

/**
 * 发送回滚通知
 */
export function sendRollbackNotification(
  webhookUrl: string,
  options: RollbackNotificationOptions
): Promise<DingtalkResult>;