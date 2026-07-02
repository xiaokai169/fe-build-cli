/**
 * 公共工具函数模块
 */

/**
 * 格式化字节数为可读格式
 * @param {number} bytes - 字节数
 * @returns {string} 可读格式
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * 格式化文件大小（别名，与 formatBytes 相同）
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  return formatBytes(bytes);
}

/**
 * 对 shell 参数进行安全转义，防止命令注入
 * 将值包裹在单引号中，并转义内部的单引号
 * @param {string} value - 需要转义的值
 * @returns {string} 转义后的安全字符串
 */
export function shellEscape(value) {
  // 将单引号替换为 '\'' (结束单引号、转义单引号、开始单引号)
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 解析备份文件名，提取版本信息
 * @param {string} filename - 文件名
 * @returns {{prefix: string, version: string}|null}
 */
export function parseBackupFilename(filename) {
  const match = filename.match(/^(.+)-build-(.+)\.tar\.gz$/);
  if (match) {
    return { prefix: match[1], version: match[2] };
  }
  return null;
}

/**
 * 格式化时间为中文格式字符串
 * @param {Date} date - 日期对象
 * @returns {string}
 */
export function formatTime(date) {
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
 * 扩展用户目录波浪号
 * @param {string} filePath - 可能包含 ~ 的路径
 * @returns {string} 展开后的绝对路径
 */
export function expandTilde(filePath) {
  if (typeof filePath !== 'string') return filePath;
  return filePath.replace(
    /^~/,
    process.env.HOME || process.env.USERPROFILE || '/root'
  );
}

/**
 * 判断当前是否为 Windows 平台
 * @returns {boolean}
 */
export function isWindows() {
  return process.platform === 'win32';
}

/**
 * 获取跨平台的 /dev/null 或 NUL
 * @returns {string}
 */
export function devNull() {
  return isWindows() ? 'NUL' : '/dev/null';
}

export default {
  formatBytes,
  formatFileSize,
  shellEscape,
  parseBackupFilename,
  formatTime,
  expandTilde,
  isWindows,
  devNull
};
