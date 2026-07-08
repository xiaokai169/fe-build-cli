/**
 * 华为云 OBS 客户端模块
 * 封装对象存储的常用操作：上传、预签名URL、列表、删除
 */
import fs from 'node:fs';
import process from 'node:process';
import ObsClient from 'esdk-obs-nodejs';
import { formatBytes } from './utils.js';

/**
 * 渲染进度条
 * @param {number} transferred - 已传输字节数
 * @param {number} total - 总字节数
 * @returns {string}
 */
function renderProgressBar(transferred, total) {
  const barWidth = 30;
  const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
  const filled = Math.round((percent / 100) * barWidth);
  return '█'.repeat(filled) + '░'.repeat(barWidth - filled) + ` ${percent}%`;
}

/**
 * OBS 客户端类
 */
export class OBSClient {
  /**
   * @param {object} obsConfig - OBS 配置
   * @param {string} obsConfig.bucket - 桶名
   * @param {string} obsConfig.endpoint - 公网 Endpoint（如 obs.cn-north-4.myhuaweicloud.com）
   * @param {string} [obsConfig.internalEndpoint] - 内网 Endpoint（服务器拉取用，可选）
   * @param {string} obsConfig.accessKeyId - 访问密钥 ID
   * @param {string} obsConfig.secretAccessKey - 访问密钥
   * @param {string} [obsConfig.uploadDir] - OBS 对象前缀
   */
  constructor(obsConfig) {
    this.bucket = obsConfig.bucket;
    this.endpoint = obsConfig.endpoint;
    this.internalEndpoint = obsConfig.internalEndpoint || obsConfig.endpoint;
    this.uploadDir = (obsConfig.uploadDir || '').replace(/\/+$/, '');

    const server = this.endpoint.includes('://')
      ? this.endpoint
      : `https://${this.endpoint}`;

    this.client = new ObsClient({
      access_key_id: obsConfig.accessKeyId,
      secret_access_key: obsConfig.secretAccessKey,
      server
    });
  }

  /**
   * 构建完整的 OBS 对象 Key（添加 uploadDir 前缀）
   * @param {string} key - 原始 key
   * @returns {string}
   */
  _buildKey(key) {
    return this.uploadDir ? `${this.uploadDir}/${key}` : key;
  }

  /**
   * 上传文件到 OBS（公网，带进度条）
   * @param {string} localFilePath - 本地文件路径
   * @param {string} objectKey - OBS 对象键（不含 uploadDir 前缀）
   * @returns {Promise<{key: string, bucket: string}>}
   */
  async uploadFile(localFilePath, objectKey) {
    const fullKey = this._buildKey(objectKey);
    const stats = fs.statSync(localFilePath);
    const totalBytes = stats.size;
    const startTime = Date.now();

    console.log(`\n📤 上传到 OBS [${this.bucket}/${fullKey}]...`);

    return new Promise((resolve, reject) => {
      let lastLog = 0;

      this.client.putObject(
        {
          Bucket: this.bucket,
          Key: fullKey,
          SourceFile: localFilePath,
          ProgressCallback: (transferred, total) => {
            const now = Date.now();
            // 每 200ms 刷新一次进度（避免刷屏）
            if (now - lastLog < 200 && transferred < total) return;
            lastLog = now;
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? transferred / elapsed : 0;
            const bar = renderProgressBar(transferred, total);
            process.stdout.write(
              `\r  ${bar} ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s  ${Math.round(elapsed)}s`
            );
          }
        },
        (err, result) => {
          process.stdout.write('\n');
          if (err) {
            console.error('❌ OBS 上传失败:', err.message);
            reject(err);
          } else {
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.log(`✅ OBS 上传完成 (${duration}s)`);
            resolve({ key: fullKey, bucket: this.bucket });
          }
        }
      );
    });
  }

  /**
   * 生成预签名 URL（同步方法）
   * 用于授权服务器 curl 下载/上传，避免在服务器存储 AK/SK
   *
   * @param {string} objectKey - OBS 对象键（不含 uploadDir 前缀）
   * @param {number} expires - 过期时间（秒），默认 3600
   * @param {'GET'|'PUT'} method - HTTP 方法
   * @param {boolean} [useInternal=false] - 是否使用内网 endpoint
   * @returns {string} 预签名 URL
   */
  getSignedUrl(objectKey, expires = 3600, method = 'GET', useInternal = false) {
    const fullKey = this._buildKey(objectKey);

    const result = this.client.createSignedUrlSync({
      Method: method,
      Bucket: this.bucket,
      Key: fullKey,
      Expires: expires
    });

    let url = result.SignedUrl;

    // 如果指定使用内网 endpoint 且配置了不同的内网地址，替换 URL 中的 hostname
    if (useInternal && this.internalEndpoint !== this.endpoint) {
      const publicHost = this.endpoint.replace(/^https?:\/\//, '');
      const internalHost = this.internalEndpoint.replace(/^https?:\/\//, '');
      url = url.replace(publicHost, internalHost);
    }

    return url;
  }

  /**
   * 列出 OBS 中指定前缀的对象（分页遍历）
   * @param {string} prefix - 对象前缀
   * @returns {Promise<Array<{key: string, lastModified: Date, size: number}>>}
   */
  async listObjects(prefix) {
    const fullPrefix = this._buildKey(prefix);
    const allObjects = [];

    const listChunk = (marker) => {
      return new Promise((resolve, reject) => {
        this.client.listObjects(
          {
            Bucket: this.bucket,
            Prefix: fullPrefix,
            Marker: marker,
            MaxKeys: 100
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
    };

    let marker;
    while (true) {
      const result = await listChunk(marker);
      const contents = result.Interface.Contents || [];
      for (const obj of contents) {
        allObjects.push({
          key: obj.Key,
          lastModified: new Date(obj.LastModified),
          size: parseInt(obj.Size, 10)
        });
      }
      if (!result.Interface.IsTruncated) break;
      marker = result.Interface.NextMarker || contents[contents.length - 1]?.Key;
    }

    return allObjects;
  }

  /**
   * 删除 OBS 中的对象
   * @param {string} objectKey - OBS 对象键（不含 uploadDir 前缀）
   * @returns {Promise<void>}
   */
  async deleteObject(objectKey) {
    const fullKey = this._buildKey(objectKey);
    return new Promise((resolve, reject) => {
      this.client.deleteObject(
        {
          Bucket: this.bucket,
          Key: fullKey
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}

export default OBSClient;
