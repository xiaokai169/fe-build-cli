import fs from 'node:fs';
import { Client } from 'ssh2';
import { formatBytes } from './utils.js';

/**
 * SSH 客户端类，用于连接服务器并执行命令、上传/下载文件
 */
export class SSHClient {
  constructor(config) {
    this.config = config;
    this.client = new Client();
    this.sftp = null;
  }

  /**
   * 判断是否为可重试的网络错误
   * @param {Error} err
   * @returns {boolean}
   */
  _isRetryableError(err) {
    const retryableCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAGAIN'];
    const retryableMessages = ['Connection lost before handshake', 'connect ETIMEDOUT'];
    return retryableCodes.includes(err.code) ||
           retryableMessages.some(m => err.message && err.message.includes(m));
  }

  /**
   * 建立 SSH 连接（带重试机制）
   * @param {number} [maxRetries=3] - 最大重试次数
   * @returns {Promise<void>}
   */
  async connect(maxRetries = 3) {
    // 检查私钥文件是否存在且权限正确
    const keyPath = (this.config.sshKeyPath || '')
      .replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/root');
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH 私钥文件不存在: ${keyPath}`);
    }

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._doConnect(keyPath);
        return; // 连接成功
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries && this._isRetryableError(err)) {
          const delay = Math.min(2000 * attempt, 10000); // 递增延迟: 2s, 4s, 6s... 最长10s
          console.error(`\n⚠️  SSH 连接失败 (${attempt}/${maxRetries}): ${err.message}`);
          console.error(`   等待 ${delay / 1000}s 后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err; // 不可重试或已达最大次数
        }
      }
    }
    throw lastError;
  }

  /**
   * 执行单次 SSH 连接
   * @param {string} keyPath - 私钥路径
   * @returns {Promise<void>}
   */
  _doConnect(keyPath) {
    return new Promise((resolve, reject) => {
      // 每次重试前创建新的 Client 实例（因为 ssh2 的 Client 不能复用）
      this.client = new Client();

      try {
        const keyContent = fs.readFileSync(keyPath);
        this.client.connect({
          host: this.config.sshHost,
          port: this.config.sshPort || 22,
          username: this.config.sshUser,
          privateKey: keyContent,
          readyTimeout: 30000, // 增加连接超时时间到 30 秒
          keepaliveInterval: 5000, // 每 5 秒发送保活信号（更频繁）
          keepaliveCountMax: 5, // 最多发送 5 次保活信号
          algorithms: {
            // 使用更稳定的加密算法
            kex: [
              'curve25519-sha256@libssh.org',
              'ecdh-sha2-nistp256',
              'ecdh-sha2-nistp384',
              'ecdh-sha2-nistp521',
              'diffie-hellman-group-exchange-sha256',
              'diffie-hellman-group14-sha256'
            ],
            cipher: [
              'aes128-ctr',
              'aes192-ctr',
              'aes256-ctr',
              'aes128-gcm',
              'aes256-gcm'
            ]
          }
        });
      } catch (err) {
        reject(new Error(`读取 SSH 私钥失败: ${err.message}`));
        return;
      }

      this.client.on('ready', () => {
        console.log('✅ SSH 连接成功');
        resolve();
      });

      this.client.on('error', err => {
        console.error('❌ SSH 连接失败:', err.message);
        reject(err);
      });

      // 处理连接关闭事件
      this.client.on('close', () => {
        console.log('ℹ️ SSH 连接已关闭');
      });

      // 处理连接结束事件
      this.client.on('end', () => {
        console.log('ℹ️ SSH 连接结束');
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
   * 通过已建立的 SSH 连接执行命令并将本地流数据管道传输到远程命令的 stdin
   * 用于 tar 管道流直传等场景，复用已有连接，不额外创建 SSH 连接
   * @param {string} command - 远程命令（需支持从 stdin 读取数据）
   * @param {stream.Readable} inputStream - 本地输入流（如 tar 的 stdout）
   * @param {function} [onProgress] - 进度回调 (bytesWritten: number) => void
   * @returns {Promise<number>} 传输的字节数
   */
  async pipeExec(command, inputStream, onProgress) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let bytesWritten = 0;
        let stderr = '';

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', (code) => {
          if (code === 0) {
            resolve(bytesWritten);
          } else {
            reject(new Error(
              `远程命令退出码: ${code}${stderr ? ', stderr: ' + stderr.trim() : ''}`
            ));
          }
        });

        // 追踪传输字节数（在 pipe 之前注册监听，两者不冲突）
        if (onProgress) {
          inputStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            onProgress(bytesWritten);
          });
        }

        // 将本地 tar 输出管道到远程 tar 的 stdin
        inputStream.pipe(stream);

        inputStream.on('error', (err) => {
          // 本地流出错时关闭远程通道
          try { stream.close(); } catch { /* 忽略 */ }
          reject(err);
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });
    });
  }

  /**
   * 上传文件到远程服务器（带进度条和兜底方式）
   * @param {string} localPath - 本地文件路径
   * @param {string} remotePath - 远程文件路径
   * @param {number} retries - 重试次数，默认 3 次
   * @returns {Promise<void>}
   */
  async uploadFile(localPath, remotePath, retries = 3) {
    const stats = fs.statSync(localPath);
    const totalBytes = stats.size;
    const startTime = Date.now();

    // 渲染进度条
    const renderBar = (transferred, total) => {
      const percent = Math.round((transferred / total) * 100);
      const barWidth = 30;
      const filled = Math.round((percent / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? transferred / elapsed : 0;
      process.stdout.write(
        `\r上传进度: [${bar}] ${percent}%  ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s`
      );
    };

    // 方式1：SFTP fastPut（带进度条）
    const trySftpUpload = async (attempt) => {
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
                console.log(`✅ SFTP 上传成功: ${localPath} -> ${remotePath}`);
                resolve();
              }
            }
          );
        });
      });
    };

    // 方式2：SSH 命令行兜底上传（不依赖 SFTP）
    const trySshFallbackUpload = async () => {
      console.log('⚠️  SFTP 上传失败，尝试 SSH 命令行兜底上传...');
      return new Promise((resolve, reject) => {
        this.client.exec(`cat > '${remotePath}'`, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          const fileStream = fs.createReadStream(localPath);
          let transferred = 0;

          fileStream.on('data', chunk => {
            stream.stdin.write(chunk);
            transferred += chunk.length;
            renderBar(transferred, totalBytes);
          });

          fileStream.on('end', () => {
            stream.stdin.end();
            renderBar(totalBytes, totalBytes);
            process.stdout.write('\n');
            console.log(`✅ SSH 命令行上传成功: ${localPath} -> ${remotePath}`);
            resolve();
          });

          fileStream.on('error', err => {
            reject(err);
          });

          stream.stderr.on('data', data => {
            console.error('SSH 上传错误:', data.toString());
          });

          stream.on('close', code => {
            if (code !== 0) {
              reject(new Error(`SSH 上传失败，退出码: ${code}`));
            }
          });
        });
      });
    };

    // 尝试 SFTP 上传，失败则使用 SSH 命令行兜底
    for (let i = 0; i < retries; i++) {
      try {
        await trySftpUpload(i + 1);
        return; // 成功则返回
      } catch (err) {
        console.log(`\n⚠️  SFTP 上传失败 (尝试 ${i + 1}/${retries}): ${err.message}`);
        if (i === retries - 1) {
          console.log('❌ SFTP 上传多次失败，切换到 SSH 命令行兜底方式');
          // 最后一次失败，使用 SSH 命令行兜底
          try {
            await trySshFallbackUpload();
            return;
          } catch (fallbackErr) {
            throw new Error(`所有上传方式失败: SFTP ${err.message}, SSH ${fallbackErr.message}`);
          }
        }
        // 等待 2 秒后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * 从远程服务器下载文件（带进度条）
   * @param {string} remotePath - 远程文件路径
   * @param {string} localPath - 本地文件路径
   * @returns {Promise<void>}
   */
  async downloadFile(remotePath, localPath) {
    const startTime = Date.now();

    // 渲染进度条
    const renderBar = (transferred, total) => {
      const percent = Math.round((transferred / total) * 100);
      const barWidth = 30;
      const filled = Math.round((percent / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? transferred / elapsed : 0;
      process.stdout.write(
        `\r下载进度: [${bar}] ${percent}%  ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s`
      );
    };

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
   * 断开 SSH 连接（带超时保护）
   * 正常调用 end() 优雅关闭，5 秒超时后强制 destroy()
   * @returns {Promise<void>}
   */
  async disconnect() {
    return new Promise(resolve => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          console.log('✅ SSH 连接已关闭');
          resolve();
        }
      };

      // 5 秒超时保护：强制销毁连接
      const timer = setTimeout(() => {
        if (!resolved) {
          console.warn('⚠️ SSH 正常关闭超时，强制断开连接');
          try { this.client.destroy(); } catch { /* 忽略 */ }
          done();
        }
      }, 5000);

      try {
        this.client.on('close', done);
        this.client.end();
      } catch (err) {
        // end() 抛异常时直接 destroy
        try { this.client.destroy(); } catch { /* 忽略 */ }
        done();
      }
    });
  }
}

export default SSHClient;
