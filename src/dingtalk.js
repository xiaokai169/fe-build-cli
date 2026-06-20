/**
 * 钉钉机器人通知模块
 */

/**
 * 发送钉钉消息
 * @param {string} webhookUrl - 钉钉机器人 webhook URL
 * @param {object} message - 消息内容
 * @returns {Promise<object>} 发送结果
 */
export async function sendDingTalkMessage(webhookUrl, message) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(message)
    });

    const result = await response.json();

    if (result.errcode !== 0) {
      console.error('❌ 钉钉消息发送失败:', result.errmsg);
      return { success: false, error: result.errmsg };
    }

    console.log('✅ 钉钉消息发送成功');
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ 钉钉消息发送失败:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 发送部署成功通知（Markdown 格式）
 * @param {string} webhookUrl - 钉钉机器人 webhook URL
 * @param {object} options - 部署信息
 * @param {string} options.environment - 环境名称
 * @param {string} options.buildVersion - 构建版本
 * @param {string} options.serverHost - 服务器地址
 * @param {string} options.deployUrl - 部署后的访问地址
 * @param {string} options.branch - 分支名称
 * @param {string} options.deployMode - 发布模式
 * @param {string} options.commitMessage - 提交信息（本次修改内容）
 * @param {string} options.duration - 部署耗时（可选）
 * @param {string} options.keyword - 安全关键词（可选）
 */
export async function sendDeploySuccessNotification(webhookUrl, options) {
  const {
    environment,
    buildVersion,
    serverHost,
    deployUrl,
    branch,
    deployMode,
    commitMessage,
    duration,
    keyword = '部署'
  } = options;

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // 标题必须包含关键词，否则钉钉会拒绝
  const title = `${keyword}成功 - ${environment}`;

  const deployModeText = deployMode === 'main' ? '主分支发布' : deployMode === 'test' ? 'Test环境发布' : '当前分支发布';

  const message = {
    msgtype: 'markdown',
    markdown: {
      title,
      text: `
## 🚀 ${keyword}成功通知

**环境**: ${environment}
**状态**: ✅ 成功
**时间**: ${timeStr}

---

### ${keyword}详情

构建版本: ${buildVersion}
发布分支: ${branch}
发布模式: ${deployModeText}
服务器: ${serverHost}
${duration ? `${keyword}耗时: ${duration}` : ''}

---

### 本次修改内容

${commitMessage || '无提交信息'}

---

### 访问地址

[${deployUrl}](${deployUrl})

> ${keyword}完成，请及时验证功能是否正常。
      `.trim()
    }
  };

  return sendDingTalkMessage(webhookUrl, message);
}

/**
 * 发送部署失败通知（Markdown 格式）
 * @param {string} webhookUrl - 钉钉机器人 webhook URL
 * @param {object} options - 部署信息
 * @param {string} options.environment - 环境名称
 * @param {string} options.buildVersion - 构建版本
 * @param {string} options.serverHost - 服务器地址
 * @param {string} options.branch - 分支名称
 * @param {string} options.commitMessage - 提交信息（本次修改内容）
 * @param {string} options.error - 错误信息
 * @param {string} options.keyword - 安全关键词（可选）
 */
export async function sendDeployFailureNotification(webhookUrl, options) {
  const {
    environment,
    buildVersion,
    serverHost,
    branch,
    commitMessage,
    error,
    keyword = '部署'
  } = options;

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // 标题必须包含关键词
  const title = `${keyword}失败 - ${environment}`;

  const message = {
    msgtype: 'markdown',
    markdown: {
      title,
      text: `
## ❌ ${keyword}失败通知

**环境**: ${environment}
**状态**: ❌ 失败
**时间**: ${timeStr}

---

### 失败详情

构建版本: ${buildVersion || '未完成'}
发布分支: ${branch}
服务器: ${serverHost}

---

### 本次修改内容

${commitMessage || '无提交信息'}

---

### 错误信息

${error}

> 请及时排查问题并重新${keyword}。
      `.trim()
    }
  };

  return sendDingTalkMessage(webhookUrl, message);
}

/**
 * 发送回滚通知（Markdown 格式）
 * @param {string} webhookUrl - 钉钉机器人 webhook URL
 * @param {object} options - 回滚信息
 * @param {string} options.environment - 环境名称
 * @param {string} options.backupFile - 备份文件
 * @param {string} options.serverHost - 服务器地址
 * @param {string} options.deployUrl - 部署后的访问地址
 * @param {boolean} options.success - 是否成功
 * @param {string} options.keyword - 安全关键词（可选）
 */
export async function sendRollbackNotification(webhookUrl, options) {
  const {
    environment,
    backupFile,
    serverHost,
    deployUrl,
    success,
    keyword = '部署'
  } = options;

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // 标题必须包含关键词
  const title = `回滚${success ? '成功' : '失败'} - ${environment}`;

  const message = {
    msgtype: 'markdown',
    markdown: {
      title,
      text: `
## ${success ? '🔄' : '❌'} 回滚${success ? '成功' : '失败'}通知

**环境**: ${environment}
**状态**: ${success ? '✅ 成功' : '❌ 失败'}
**时间**: ${timeStr}

---

### 回滚详情

服务器: ${serverHost}
备份文件: ${backupFile}

---

${success ? `### 访问地址

[${deployUrl}](${deployUrl})` : `### 错误信息

回滚失败，请检查备份文件是否存在或手动处理。`}

> ${success ? '回滚完成，请验证功能是否正常。' : '回滚失败，请手动处理。'}（${keyword}系统）
      `.trim()
    }
  };

  return sendDingTalkMessage(webhookUrl, message);
}

export default {
  sendDingTalkMessage,
  sendDeploySuccessNotification,
  sendDeployFailureNotification,
  sendRollbackNotification
};