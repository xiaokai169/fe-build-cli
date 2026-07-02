/**
 * 命令模块共享工具
 */
import { createInterface } from 'node:readline';

/**
 * 创建交互式提示器
 * @returns {{ ask: (question: string) => Promise<string>, close: () => void }}
 */
export function createPrompter() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return {
    ask: (question) => new Promise(resolve => {
      rl.question(question, answer => {
        resolve(answer.trim());
      });
    }),
    close: () => rl.close()
  };
}

/**
 * 从配置中获取服务器名称列表
 * @param {object} config
 * @returns {string[]}
 */
export function getServerNames(config) {
  if (config.servers) {
    return Object.keys(config.servers).filter(k => config.servers[k].sshHost !== undefined);
  }
  // 旧格式兼容
  return Object.keys(config).filter(k => config[k].sshHost !== undefined);
}

/**
 * 获取服务器配置
 * @param {object} config
 * @param {string} serverName
 * @returns {object|null}
 */
export function getServerConfig(config, serverName) {
  if (config.servers) {
    return config.servers[serverName];
  }
  return config[serverName];
}
