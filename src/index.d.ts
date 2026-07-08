/**
 * fe-build-cli TypeScript 类型声明
 */

// ====== 公共工具 ======
export function formatBytes(bytes: number): string;
export function formatFileSize(bytes: number): string;
export function shellEscape(value: string): string;
export function parseBackupFilename(filename: string): { prefix: string; version: string } | null;
export function formatTime(date: Date): string;
export function expandTilde(filePath: string): string;
export function isWindows(): boolean;
export function devNull(): string;

// ====== 配置 ======
export interface OBSConfig {
  bucket: string;
  endpoint: string;
  internalEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  uploadDir?: string;
}

export interface ServerConfig {
  sshHost: string;
  sshUser: string;
  sshPort?: number;
  sshKeyPath: string;
  deployUrl?: string;
  backupDir: string;
  deployDir: string;
  backupPrefix: string;
  buildMode?: 'production' | 'test';
  buildCommand?: string;
  protectedDirs?: string[];
  backupRetentionCount?: number;
  transferMode?: 'pipe' | 'rsync' | 'sftp' | 'obs' | 'git';
  gitRelease?: { repo: string; branch?: string };
  obsConfig?: OBSConfig;
}

export interface FeBuildConfig {
  branches?: { test: string; main: string };
  deployMode?: 'simple' | 'current';
  dingtalk?: DingtalkConfig;
  servers: Record<string, ServerConfig>;
  backupRetentionCount?: number;
  logDir?: string;
  enableBackupDownload?: boolean;
  localBackupDir?: string;
}

export interface DingtalkConfig {
  webhook: string;
  enabled?: boolean;
  keyword?: string;
}

// ====== SSH 客户端 ======
export class SSHClient {
  constructor(config: ServerConfig);
  connect(): Promise<void>;
  execCommand(command: string): Promise<string>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  disconnect(): Promise<void>;
}

// ====== OBS 客户端 ======
export class OBSClient {
  constructor(obsConfig: OBSConfig);
  uploadFile(localFilePath: string, objectKey: string): Promise<{ key: string; bucket: string }>;
  getSignedUrl(objectKey: string, expires?: number, method?: 'GET' | 'PUT', useInternal?: boolean): string;
  listObjects(prefix: string): Promise<Array<{ key: string; lastModified: Date; size: number }>>;
  deleteObject(objectKey: string): Promise<void>;
}

// ====== Git 信息查询 ======
export function getCurrentBranch(): string;
export function getGitSha(): string;
export function getGitCommitMessage(): string;
export function getGitCommitMessages(count?: number): string;
export function isWorkingTreeClean(): boolean;
export function checkUncommittedChanges(): { clean: boolean; changes: string[] };
export function executeCurrentBranchFlow(): { success: boolean; currentBranch: string; gitSha: string };
export function executeSimpleFlow(): { success: boolean; currentBranch: string; gitSha: string; clean: boolean };

// ====== 部署核心 ======
export function getServerBackupList(ssh: SSHClient, envConfig: ServerConfig): Promise<BackupFile[]>;
export function getLocalBackupList(localBackupDir: string, backupPrefix: string): BackupFile[];
export function getOBSBackupList(envConfig: ServerConfig): Promise<BackupFile[]>;
export function rollbackFromLocal(options: RollbackLocalOpts): Promise<string>;
export function buildProject(envConfig: ServerConfig, buildVersion: string, logger: DeployLogger): void;
export function verifyBuildOutput(skipBuild: boolean, logger: DeployLogger): void;
export function compressBuild(localZipFile: string, logger: DeployLogger): Promise<void>;
export function backupExistingDeployment(options: BackupOpts): Promise<void>;
export function pipeUploadDeploy(options: PipeDeployOpts): Promise<void>;
export function obsUploadDeploy(options: ObsDeployOpts): Promise<void>;
export function gitUploadDeploy(options: ObsDeployOpts): Promise<void>;
export function uploadBuild(options: UploadOpts): Promise<void>;
export function deployAndExtract(options: ExtractOpts): Promise<void>;
export function cleanupFiles(options: CleanupOpts): Promise<void>;
export function downloadBackup(options: DownloadBackupOpts): Promise<string | null>;
export function deployToServer(options: DeployToServerOpts): Promise<void>;
export function rollbackDeployment(options: RollbackDeployOpts): Promise<void>;

export interface BackupFile {
  file: string;
  filename: string;
  prefix?: string;
  version: string;
  mtime?: Date;
  size?: number;
  isServer: boolean;
  isOBS?: boolean;
}

export interface ObsDeployOpts {
  ssh: SSHClient;
  envConfig: ServerConfig;
  buildVersion: string;
  logger: DeployLogger;
  skipBackup?: boolean;
}

export interface PipeDeployOpts {
  ssh: SSHClient;
  envConfig: ServerConfig;
  buildVersion: string;
  logger: DeployLogger;
}

export interface BackupOpts extends PipeDeployOpts {
  suffix?: string;
}

export interface UploadOpts {
  ssh: SSHClient;
  localZipFile: string;
  remoteZipFile: string;
  logger: DeployLogger;
}

export interface ExtractOpts {
  ssh: SSHClient;
  envConfig: ServerConfig;
  remoteZipFile: string;
  logger: DeployLogger;
}

export interface CleanupOpts {
  ssh: SSHClient;
  remoteZipFile: string;
  localZipFile: string;
  skipLocalCleanup: boolean;
  logger: DeployLogger;
}

export interface DownloadBackupOpts {
  ssh: SSHClient;
  envConfig: ServerConfig;
  buildVersion: string;
  localBackupDir: string;
  logger: DeployLogger;
}

export interface DeployToServerOpts {
  environment: string;
  envConfig: ServerConfig;
  buildVersion: string;
  skipBuild?: boolean;
  skipLocalCleanup?: boolean;
  logger: DeployLogger;
  localBackupDir?: string;
  enableBackupDownload?: boolean;
}

export interface RollbackDeployOpts {
  environment: string;
  envConfig: ServerConfig;
  specifiedVersion?: string;
  backupFile?: string;
  ssh?: SSHClient;
  logger: DeployLogger;
}

export interface RollbackLocalOpts {
  ssh: SSHClient;
  envConfig: ServerConfig;
  localBackupFile: string;
  logger: DeployLogger;
}

// ====== 钉钉通知 ======
export function sendDingTalkMessage(webhookUrl: string, message: object): Promise<DingTalkResult>;
export function sendDeploySuccessNotification(webhookUrl: string, options: DeploySuccessOpts): Promise<DingTalkResult>;
export function sendDeployFailureNotification(webhookUrl: string, options: DeployFailureOpts): Promise<DingTalkResult>;
export function sendRollbackNotification(webhookUrl: string, options: RollbackNotifyOpts): Promise<DingTalkResult>;

export interface DingTalkResult {
  success: boolean;
  error?: string;
  data?: any;
}

export interface DeploySuccessOpts {
  environment: string;
  buildVersion: string;
  serverHost: string;
  deployUrl?: string;
  branch: string;
  deployMode: string;
  commitMessage: string;
  duration?: string;
  keyword?: string;
}

export interface DeployFailureOpts {
  environment: string;
  buildVersion: string;
  serverHost: string;
  branch: string;
  commitMessage: string;
  error: string;
  keyword?: string;
}

export interface RollbackNotifyOpts {
  environment: string;
  backupFile: string;
  serverHost: string;
  deployUrl?: string;
  success: boolean;
  keyword?: string;
}

// ====== 日志记录 ======
export class DeployLogger {
  constructor(options?: { logDir?: string; backupDir?: string });
  start(): void;
  end(status?: string): void;
  log(level: string, step: string, message: string, data?: any): void;
  logBuild(buildMode: string, buildVersion: string, success: boolean, duration?: number): void;
  logCompress(fileSize: number, success: boolean): void;
  logSSHConnect(host: string, success: boolean): void;
  logUpload(localFile: string, remoteFile: string, fileSize: number, duration: number, success: boolean): void;
  logBackup(backupFile: string, success: boolean, isDownload?: boolean): void;
  logDeploy(deployDir: string, success: boolean): void;
  logDingTalk(success: boolean, message?: string): void;
  logOBS(operation: string, bucket: string, objectKey: string, success: boolean): void;
  saveLog(): string;
  saveErrorLog(): string;
  getSummary(): LogSummary;
}

export interface LogSummary {
  startTime: string;
  endTime: string;
  duration: number;
  status: string;
  totalSteps: number;
  successSteps: number;
  failedSteps: number;
}

export function cleanLocalBackups(backupDir: string, retentionDays?: number): void;

// ====== 更新模块 ======
export function getCurrentVersion(): string;
export function getLatestVersion(): Promise<string>;
export function checkForUpdate(): Promise<UpdateInfo>;
export function performUpdate(global?: boolean): Promise<boolean>;
export function showUpdateInfo(): Promise<UpdateInfo | null>;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

// ====== 配置校验 ======
export function validateConfig(config: any): { valid: boolean; errors: Array<{ field: string; message: string }> };

// ====== 预检模块 ======
export function runPreflightChecks(options: PreflightOptions): Promise<PreflightResult>;

export interface PreflightOptions {
  environment: string;
  envConfig: ServerConfig;
  config?: any;
  quick?: boolean;
}

export interface PreflightResult {
  results: CheckResult[];
  canDeploy: boolean;
  failCount: number;
  warnCount: number;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

// ====== 初始化模块 ======
export function runInit(options?: { cwd?: string }): Promise<string | null>;
