/**
 * fe-build-cli - 前端项目打包部署工具
 *
 * 导出所有模块供外部使用
 */

// 公共工具
export {
  formatBytes,
  formatFileSize,
  shellEscape,
  parseBackupFilename,
  formatTime,
  expandTilde,
  isWindows,
  devNull
} from './utils.js';

// SSH 客户端
export { SSHClient } from './ssh-client.js';

// OBS 客户端
export { OBSClient } from './obs-client.js';

// Git 分支管理（仅信息查询，不含合并操作）
export {
  getCurrentBranch,
  getGitSha,
  getGitCommitMessage,
  getGitCommitMessages,
  isWorkingTreeClean,
  checkUncommittedChanges,
  executeCurrentBranchFlow,
  executeSimpleFlow
} from './git-branch.js';

// 部署核心逻辑
export {
  checkRsyncAvailable,
  rsyncUploadDeploy,
  pipeUploadDeploy,
  obsUploadDeploy,
  gitUploadDeploy,
  resolveOBSConfig,
  buildProject,
  verifyBuildOutput,
  compressBuild,
  backupExistingDeployment,
  uploadBuild,
  deployAndExtract,
  cleanupFiles,
  downloadBackup,
  deployToServer,
  rollbackDeployment,
  getServerBackupList,
  getLocalBackupList,
  getOBSBackupList,
  rollbackFromLocal
} from './deploy-core.js';

// 钉钉通知
export {
  sendDingTalkMessage,
  sendDeploySuccessNotification,
  sendDeployFailureNotification,
  sendRollbackNotification
} from './dingtalk.js';

// 日志记录
export {
  DeployLogger,
  cleanLocalBackups
} from './logger.js';

// 更新模块
export {
  getCurrentVersion,
  getLatestVersion,
  checkForUpdate,
  performUpdate,
  showUpdateInfo
} from './update.js';

// 配置模板
export { default as configTemplate, validateConfig } from './config-template.js';

// 预检模块
export { runPreflightChecks } from './preflight.js';

// 初始化模块
export { runInit } from './init.js';
