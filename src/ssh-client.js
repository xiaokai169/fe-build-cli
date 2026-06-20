import fs from 'node:fs';
import { Client } from 'ssh2';

/**
 * SSH 客户端类，用于连接服务器并执行命令、上传文件
 */
export class SSHClient {
  constructor(config) {
    this.config = config;
    this.client = new Client();
    this.sftp = null;
  }

  /**
   * 建立 SSH 连接
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.client.connect({
        host: this.config.sshHost,
        port: this.config.sshPort || 22,
        username: this.config.sshUser,
        privateKey: fs.readFileSync(this.config.sshKeyPath),
        readyTimeout: 15000
      });

      this.client.on('ready', () => {
        console.log('✅ SSH 连接成功');
        resolve();
      });

      this.client.on('error', err => {
        console.error('❌ SSH 连接失败:', err.message);
        reject(err);
      });
    });
  }

  /**
   * 在远程服务器执行命令
   * @param {string} command - 要执行的命令
   * @returns {Promise<string>} 命令输出
   */
  async execCommand(command) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('data', data => {
          const chunk = data.toString();
          output += chunk;
          process.stdout.write(chunk);
        });

        stream.stderr.on('data', data => {
          const chunk = data.toString();
          errorOutput += chunk;
          process.stderr.write(chunk);
        });

        stream.on('close', code => {
          if (code === 0) {
            resolve(output);
          } else {
            reject(new Error(`命令执行失败，退出码: ${code}, 错误信息: ${errorOutput}`));
          }
        });
      });
    });
  }

  /**
   * 上传文件到远程服务器（带进度条）
   * @param {string} localPath - 本地文件路径
   * @param {string} remotePath - 远程文件路径
   * @returns {Promise<void>}
   */
  async uploadFile(localPath, remotePath) {
    const stats = fs.statSync(localPath);
    const totalBytes = stats.size;
    const startTime = Date.now();

    // 格式化字节数为可读格式
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // 渲染进度条
    function renderBar(transferred, total) {
      const percent = Math.round((transferred / total) * 100);
      const barWidth = 30;
      const filled = Math.round((percent / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? transferred / elapsed : 0;
      process.stdout.write(
        `\r上传进度: [${bar}] ${percent}%  ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s`
      );
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        sftp.fastPut(
          localPath,
          remotePath,
          {
            step: (transferred, _chunk, total) => {
              renderBar(transferred, total);
            }
          },
          err => {
            if (err) {
              reject(err);
            } else {
              renderBar(totalBytes, totalBytes);
              process.stdout.write('\n');
              console.log(`✅ 上传成功: ${localPath} -> ${remotePath}`);
              resolve();
            }
          }
        );
      });
    });
  }

  /**
   * 从远程服务器下载文件（带进度条）
   * @param {string} remotePath - 远程文件路径
   * @param {string} localPath - 本地文件路径
   * @returns {Promise<void>}
   */
  async downloadFile(remotePath, localPath) {
    const startTime = Date.now();

    // 格式化字节数为可读格式
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // 渲染进度条
    function renderBar(transferred, total) {
      const percent = Math.round((transferred / total) * 100);
      const barWidth = 30;
      const filled = Math.round((percent / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? transferred / elapsed : 0;
      process.stdout.write(
        `\r下载进度: [${bar}] ${percent}%  ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s`
      );
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        // 先获取文件大小
        sftp.stat(remotePath, (err, stats) => {
          if (err) {
            reject(err);
            return;
          }

          const totalBytes = stats.size;

          sftp.fastGet(
            remotePath,
            localPath,
            {
              step: (transferred, _chunk, total) => {
                renderBar(transferred, total);
              }
            },
            err => {
              if (err) {
                reject(err);
              } else {
                renderBar(totalBytes, totalBytes);
                process.stdout.write('\n');
                console.log(`✅ 下载成功: ${remotePath} -> ${localPath}`);
                resolve();
              }
            }
          );
        });
      });
    });
  }

  /**
   * 断开 SSH 连接
   * @returns {Promise<void>}
   */
  async disconnect() {
    return new Promise(resolve => {
      this.client.end();
      console.log('✅ SSH 连接已关闭');
      resolve();
    });
  }
}

export default SSHClient;