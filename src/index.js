/**
 * fe-build-cli - 前端项目打包部署工具
 *
 * 导出所有模块供外部使用
 */

// SSH 客户端
export { SSHClient } from './ssh-client.js';

// Git 分支管理
export {
  getCurrentBranch,
  getGitSha,
  getGitCommitMessage,
  getGitCommitMessages,
  isWorkingTreeClean,
  checkUncommittedChanges,
  checkoutBranch,
  pullBranch,
  mergeBranch,
  pushBranch,
  stashChanges,
  stashPop,
  autoCommit,
  executeMainBranchFlow,
  executeCurrentBranchFlow,
  executeTestBranchFlow,
  restoreBranch
} from './git-branch.js';

// 部署核心逻辑
export {
  checkRsyncAvailable,
  rsyncUploadDeploy,
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
export { default as configTemplate } from './config-template.js';