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
  buildProject,
  verifyBuildOutput,
  compressBuild,
  backupExistingDeployment,
  uploadBuild,
  deployAndExtract,
  cleanupFiles,
  deployToServer,
  rollbackDeployment
} from './deploy-core.js';

// 钉钉通知
export {
  sendDingTalkMessage,
  sendDeploySuccessNotification,
  sendDeployFailureNotification,
  sendRollbackNotification
} from './dingtalk.js';

// 配置模板
export { default as configTemplate } from './config-template.js';