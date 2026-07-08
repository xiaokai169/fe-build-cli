import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { formatFileSize } from './utils.js';

/**
 * 日志记录模块
 * 记录部署过程中的每一步操作及状态
 */

/**
 * 日志记录器类
 */
export class DeployLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || 'logs';
    this.backupDir = options.backupDir || '';
    this.logs = [];
    this.startTime = null;
    this.endTime = null;
    this.hasError = false;
    this.errorLog = null;
  }

  /**
   * 开始记录
   */
  start() {
    this.startTime = new Date();
    this.logs = [];
    this.hasError = false;
    this.log('INFO', '部署开始', `开始时间: ${this.formatTime(this.startTime)}`);
  }

  /**
   * 结束记录
   */
  end(status = 'success') {
    this.endTime = new Date();
    const duration = Math.round((this.endTime - this.startTime) / 1000);
    this.log('INFO', '部署结束', `结束时间: ${this.formatTime(this.endTime)}, 总耗时: ${duration}秒, 状态: ${status}`);

    // 保存日志文件
    this.saveLog();

    // 如果有错误，单独保存错误日志
    if (this.hasError) {
      this.saveErrorLog();
    }
  }

  /**
   * 记录日志
   * @param {string} level - 日志级别: INFO, SUCCESS, ERROR, WARN
   * @param {string} step - 操作步骤名称
   * @param {string} message - 详细信息
   * @param {object} data - 附加数据
   */
  log(level, step, message, data = null) {
    const timestamp = new Date();
    const logEntry = {
      timestamp: this.formatTime(timestamp),
      level,
      step,
      message,
      data,
      success: level !== 'ERROR'
    };

    this.logs.push(logEntry);

    // 如果是错误，标记
    if (level === 'ERROR') {
      this.hasError = true;
      this.errorLog = logEntry;
    }

    // 同时输出到控制台
    const prefix = this.getLevelPrefix(level);
    console.log(`${prefix} [${step}] ${message}`);
  }

  /**
   * 获取日志级别前缀
   */
  getLevelPrefix(level) {
    switch (level) {
      case 'INFO':
        return '📋';
      case 'SUCCESS':
        return '✅';
      case 'ERROR':
        return '❌';
      case 'WARN':
        return '⚠️';
      default:
        return '📝';
    }
  }

  /**
   * 格式化时间
   */
  formatTime(date) {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  /**
   * 记录构建操作
   */
  logBuild(buildMode, buildVersion, success, duration = 0) {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      '项目构建',
      `构建模式: ${buildMode}, 版本: ${buildVersion}, 耗时: ${duration}秒, ${success ? '成功' : '失败'}`,
      { buildMode, buildVersion, duration }
    );
  }

  /**
   * 记录压缩操作
   */
  logCompress(fileSize, success) {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      '文件压缩',
      `压缩包大小: ${formatFileSize(fileSize)}, ${success ? '成功' : '失败'}`,
      { fileSize }
    );
  }

  /**
   * 记录 SSH 连接
   */
  logSSHConnect(host, success) {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      'SSH连接',
      `服务器: ${host}, ${success ? '连接成功' : '连接失败'}`,
      { host }
    );
  }

  /**
   * 记录上传操作
   */
  logUpload(localFile, remoteFile, fileSize, duration, success) {
    const speed = duration > 0 ? Math.round(fileSize / duration) : 0;
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      '文件上传',
      `本地: ${localFile}, 远程: ${remoteFile}, 大小: ${formatFileSize(fileSize)}, 耗时: ${duration}秒, 速度: ${formatFileSize(speed)}/s`,
      { localFile, remoteFile, fileSize, duration, speed }
    );
  }

  /**
   * 记录备份操作
   */
  logBackup(backupFile, success, isDownload = false) {
    const action = isDownload ? '备份下载' : '服务器备份';
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      action,
      `备份文件: ${backupFile}, ${success ? '成功' : '失败'}`,
      { backupFile, isDownload }
    );
  }

  /**
   * 记录部署操作
   */
  logDeploy(deployDir, success) {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      '部署解压',
      `部署目录: ${deployDir}, ${success ? '成功' : '失败'}`,
      { deployDir }
    );
  }

  /**
   * 记录 OBS 操作
   * @param {string} operation - 操作类型（上传/下载/备份/清理）
   * @param {string} bucket - 桶名
   * @param {string} objectKey - 对象键
   * @param {boolean} success - 是否成功
   */
  logOBS(operation, bucket, objectKey, success) {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      `OBS ${operation}`,
      `桶: ${bucket}, 对象: ${objectKey}, ${success ? '成功' : '失败'}`,
      { bucket, objectKey }
    );
  }

  /**
   * 记录钉钉通知
   */
  logDingTalk(success, message = '') {
    this.log(
      success ? 'SUCCESS' : 'ERROR',
      '钉钉通知',
      `${success ? '发送成功' : '发送失败'}: ${message}`,
      { success }
    );
  }

  /**
   * 保存日志文件
   */
  saveLog() {
    // 确保日志目录存在
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // 生成日志文件名
    const dateStr = this.startTime.toISOString().slice(0, 10);
    const timeStr = this.startTime.toISOString().slice(11, 19).replace(/:/g, '-');
    const status = this.hasError ? 'failed' : 'success';
    const logFileName = `deploy-${dateStr}-${timeStr}-${status}.json`;
    const logFilePath = path.join(this.logDir, logFileName);

    // 构建完整日志对象
    const fullLog = {
      summary: {
        startTime: this.formatTime(this.startTime),
        endTime: this.formatTime(this.endTime),
        duration: Math.round((this.endTime - this.startTime) / 1000),
        status: this.hasError ? 'failed' : 'success',
        totalSteps: this.logs.length,
        successSteps: this.logs.filter(l => l.success).length,
        failedSteps: this.logs.filter(l => !l.success).length
      },
      logs: this.logs
    };

    // 保存日志
    fs.writeFileSync(logFilePath, JSON.stringify(fullLog, null, 2));
    console.log(`\n📝 日志已保存: ${logFilePath}`);

    return logFilePath;
  }

  /**
   * 保存错误日志（单独一份）
   */
  saveErrorLog() {
    if (!this.hasError) return;

    // 确保日志目录存在
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // 生成错误日志文件名
    const dateStr = this.startTime.toISOString().slice(0, 10);
    const timeStr = this.startTime.toISOString().slice(11, 19).replace(/:/g, '-');
    const errorLogFileName = `error-${dateStr}-${timeStr}.json`;
    const errorLogFilePath = path.join(this.logDir, errorLogFileName);

    // 构建错误日志对象
    const errorLogData = {
      summary: {
        startTime: this.formatTime(this.startTime),
        endTime: this.formatTime(this.endTime),
        status: 'failed'
      },
      error: this.errorLog,
      allLogs: this.logs
    };

    // 保存错误日志
    fs.writeFileSync(errorLogFilePath, JSON.stringify(errorLogData, null, 2));
    console.log(`\n❌ 错误日志已保存: ${errorLogFilePath}`);

    return errorLogFilePath;
  }

  /**
   * 获取日志摘要
   */
  getSummary() {
    return {
      startTime: this.formatTime(this.startTime),
      endTime: this.formatTime(this.endTime),
      duration: Math.round((this.endTime - this.startTime) / 1000),
      status: this.hasError ? 'failed' : 'success',
      totalSteps: this.logs.length,
      successSteps: this.logs.filter(l => l.success).length,
      failedSteps: this.logs.filter(l => !l.success).length
    };
  }
}

/**
 * 清理本地备份（保留 N 天）
 * @param {string} backupDir - 本地备份目录
 * @param {number} retentionDays - 保留天数
 */
export function cleanLocalBackups(backupDir, retentionDays = 7) {
  if (!fs.existsSync(backupDir)) {
    console.log(`备份目录不存在: ${backupDir}`);
    return;
  }

  const now = new Date();
  const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  console.log(`\n🗑️ 清理本地备份（保留 ${retentionDays} 天）...`);
  console.log(`截止日期: ${cutoffDate.toLocaleDateString('zh-CN')}`);

  // 获取所有备份文件
  const files = fs.readdirSync(backupDir);
  const backupFiles = files.filter(f => f.endsWith('.tar.gz') || f.endsWith('.tgz'));

  let deletedCount = 0;
  let keptCount = 0;

  backupFiles.forEach(file => {
    const filePath = path.join(backupDir, file);
    const stats = fs.statSync(filePath);
    const fileDate = new Date(stats.mtime);

    if (fileDate < cutoffDate) {
      // 删除旧备份
      fs.unlinkSync(filePath);
      console.log(`  已删除: ${file} (${fileDate.toLocaleDateString('zh-CN')})`);
      deletedCount++;
    } else {
      keptCount++;
    }
  });

  console.log(`✅ 清理完成: 删除 ${deletedCount} 个, 保留 ${keptCount} 个`);
}

export default {
  DeployLogger,
  cleanLocalBackups
};
