import { execSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import SSHClient from './ssh-client.js';

/**
 * 构建项目
 * @param {object} envConfig - 环境配置
 * @param {string} buildVersion - 构建版本号
 */
export function buildProject(envConfig, buildVersion) {
  console.log('\n[步骤 1/8] 构建项目...');
  const buildMode = envConfig.buildMode || 'production';
  const buildCommand = envConfig.buildCommand || (buildMode === 'production' ? 'yarn build-only' : 'yarn build-test');
  console.log(`构建模式: ${buildMode} → ${buildCommand}`);
  process.env.VITE_APP_VERSION = buildVersion;
  execSync(buildCommand, { stdio: 'inherit' });
  console.log('✅ 构建完成');
}

/**
 * 验证构建输出
 * @param {boolean} skipBuild - 是否跳过构建
 */
export function verifyBuildOutput(skipBuild) {
  console.log(skipBuild ? '\n[步骤 1/7] 验证构建输出...' : '\n[步骤 2/8] 验证构建输出...');
  if (!fs.existsSync('dist')) {
    console.error('❌ 构建目录不存在!');
    process.exit(1);
  }
  console.log('✅ 验证完成');
}

/**
 * 压缩构建产物
 * @param {string} localZipFile - 本地压缩包路径
 * @param {boolean} skipBuild - 是否跳过构建
 */
export function compressBuild(localZipFile, skipBuild) {
  console.log(skipBuild ? '\n[步骤 2/7] 压缩本地构建产物...' : '\n[步骤 3/8] 压缩本地构建产物...');
  execSync(`tar -czf ${localZipFile} -C dist .`, { stdio: 'inherit' });
  console.log('✅ 压缩完成');
}

/**
 * 备份现有部署
 * @param {object} options - 选项
 */
export async function backupExistingDeployment(options) {
  const { ssh, envConfig, buildVersion, skipBuild } = options;
  const stepNum = skipBuild ? '3' : '4';
  console.log(`\n[步骤 ${stepNum}/8] 备份现有部署...`);
  const backupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${buildVersion}.tar.gz`;

  await ssh.execCommand(`mkdir -p ${envConfig.backupDir}`);
  await ssh.execCommand(`ls -la ${envConfig.deployDir} || echo '部署目录可能不存在'`);

  const checkDirCommand = `[ -d ${envConfig.deployDir} ] && [ "$(ls -A ${envConfig.deployDir} 2>/dev/null)" ] && echo 'has_files' || echo 'empty'`;
  const checkResult = await ssh.execCommand(checkDirCommand);

  if (checkResult.includes('has_files')) {
    console.log('部署目录非空,开始备份...');
    // 排除受保护目录，减小备份体积并避免权限问题
    const protectedDirs = envConfig.protectedDirs || [];
    const excludeArgs = protectedDirs.map(d => `--exclude='./${d}'`).join(' ');
    await ssh.execCommand(`tar -czf ${backupFile} ${excludeArgs} -C ${envConfig.deployDir} .`);
    console.log('✅ 备份完成');

    await ssh.execCommand(
      `ls -t ${envConfig.backupDir}/${envConfig.backupPrefix}*.tar.gz 2>/dev/null | tail -n +2 | xargs rm -f`
    );
    console.log('✅ 清理旧备份完成');
  } else {
    console.log('部署目录为空或不存在,跳过备份');
  }
}

/**
 * 上传构建产物
 * @param {SSHClient} ssh - SSH 客户端实例
 * @param {string} localZipFile - 本地压缩包路径
 * @param {string} remoteZipFile - 远程压缩包路径
 * @param {boolean} skipBuild - 是否跳过构建
 */
export async function uploadBuild(ssh, localZipFile, remoteZipFile, skipBuild) {
  const stepNum = skipBuild ? '4' : '5';
  console.log(`\n[步骤 ${stepNum}/8] 上传压缩包...`);
  await ssh.uploadFile(localZipFile, remoteZipFile);
  await ssh.execCommand(`ls -lh ${remoteZipFile}`);
  console.log('✅ 上传完成');
}

/**
 * 清理部署目录并解压新版本
 * @param {object} options - 选项
 */
export async function deployAndExtract(options) {
  const { ssh, envConfig, remoteZipFile, skipBuild } = options;
  const stepNum = skipBuild ? '5' : '6';
  console.log(`\n[步骤 ${stepNum}/8] 清理并解压新版本...`);

  const protectedDirs = envConfig.protectedDirs || [];

  // 确保部署目录存在
  await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

  // 清空部署目录，但跳过受保护目录
  if (protectedDirs.length > 0) {
    console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
    const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
    await ssh.execCommand(
      `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
    );
    console.log('✅ 已清理非保护目录的文件');
  } else {
    await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
  }

  // 解压新版本
  await ssh.execCommand(`tar -xzf ${remoteZipFile} -C ${envConfig.deployDir}`);
  console.log('✅ 清理并解压完成');
}

/**
 * 清理临时文件
 * @param {object} options - 选项
 */
export async function cleanupFiles(options) {
  const { ssh, remoteZipFile, localZipFile, skipLocalCleanup, skipBuild } = options;
  const stepNum = skipBuild ? '6' : '7';
  console.log(`\n[步骤 ${stepNum}/8] 删除压缩包...`);
  await ssh.execCommand(`rm -f ${remoteZipFile}`);
  if (!skipLocalCleanup) {
    fs.unlinkSync(localZipFile);
  }
  console.log('✅ 删除完成');
}

/**
 * 执行部署到服务器
 * @param {object} options - 部署选项
 * @param {string} options.environment - 环境名称
 * @param {object} options.envConfig - 环境配置
 * @param {string} options.buildVersion - 构建版本
 * @param {boolean} options.skipBuild - 是否跳过构建
 * @param {boolean} options.skipLocalCleanup - 是否跳过本地清理
 */
export async function deployToServer(options) {
  const { environment, envConfig, buildVersion, skipBuild = false, skipLocalCleanup = false } = options;

  const localZipFile = `dist-${buildVersion}.tar.gz`;
  const remoteZipFile = `${envConfig.backupDir}/${localZipFile}`;

  if (!skipBuild) {
    buildProject(envConfig, buildVersion);
  }

  verifyBuildOutput(skipBuild);
  compressBuild(localZipFile, skipBuild);

  const ssh = new SSHClient(envConfig);

  try {
    await ssh.connect();
    await backupExistingDeployment({ ssh, envConfig, buildVersion, skipBuild });
    await uploadBuild(ssh, localZipFile, remoteZipFile, skipBuild);

    try {
      await deployAndExtract({ ssh, envConfig, remoteZipFile, skipBuild });
    } catch (error) {
      console.error('❌ 清理或解压失败!');
      await ssh.disconnect();
      throw error;
    }

    try {
      await cleanupFiles({ ssh, remoteZipFile, localZipFile, skipLocalCleanup, skipBuild });
    } catch (error) {
      console.warn('⚠️  删除压缩包失败,但不影响部署');
    }

    await ssh.disconnect();

    if (!skipBuild) {
      fs.writeFileSync('deployed_version.txt', buildVersion);
    }

    console.log('\n========================================');
    console.log('✅ 部署成功完成!');
    console.log(`环境: ${environment}`);
    console.log(`版本: ${buildVersion}`);
    console.log(`服务器: ${envConfig.sshHost}`);
    console.log(`地址: ${envConfig.deployUrl}`);
    console.log('========================================');
  } catch (error) {
    console.error('部署失败:', error);
    await ssh.disconnect();
    throw error;
  }
}

/**
 * 执行回滚
 * @param {object} options - 回滚选项
 * @param {string} options.environment - 环境名称
 * @param {object} options.envConfig - 环境配置
 * @param {string} options.specifiedVersion - 指定版本（可选）
 */
export async function rollbackDeployment(options) {
  const { environment, envConfig, specifiedVersion } = options;

  console.log('========================================');
  console.log(`开始回滚 ${environment} 环境`);
  console.log(`服务器: ${envConfig.sshHost}`);
  console.log('========================================');

  const ssh = new SSHClient(envConfig);

  try {
    await ssh.connect();

    console.log('\n[步骤 1/4] 获取备份文件...');

    let backupFile;
    if (specifiedVersion) {
      backupFile = `${envConfig.backupDir}/${envConfig.backupPrefix}-${specifiedVersion}.tar.gz`;
      console.log(`使用指定版本: ${specifiedVersion}`);
    } else {
      const listCommand = `ls -t ${envConfig.backupDir}/${envConfig.backupPrefix}*.tar.gz 2>/dev/null | head -n 1`;
      try {
        const listResult = await ssh.execCommand(listCommand);
        backupFile = listResult.trim();

        if (!backupFile) {
          console.error('❌ 未找到备份文件!');
          await ssh.disconnect();
          process.exit(1);
        }
        console.log(`找到最新备份: ${backupFile}`);
      } catch (error) {
        console.error('❌ 获取备份文件失败!');
        await ssh.disconnect();
        process.exit(1);
      }
    }

    console.log('\n[步骤 2/4] 验证备份文件...');
    const checkCommand = `test -f '${backupFile}' && echo 'FILE_YES' || echo 'FILE_NO'`;
    const exists = await ssh.execCommand(checkCommand);

    if (!exists.includes('FILE_YES')) {
      console.error(`❌ 备份文件不存在: ${backupFile}`);
      await ssh.disconnect();
      process.exit(1);
    }
    console.log('✅ 备份文件验证完成');

    const protectedDirs = envConfig.protectedDirs || [];

    console.log('\n[步骤 3/4] 执行回滚...');

    try {
      await ssh.execCommand(`mkdir -p ${envConfig.deployDir}`);

      if (protectedDirs.length > 0) {
        console.log(`🔒 保护目录: ${protectedDirs.join(', ')}`);
        const excludeArgs = protectedDirs.map(d => `! -name '${d}'`).join(' ');
        await ssh.execCommand(
          `find ${envConfig.deployDir} -maxdepth 1 -mindepth 1 ${excludeArgs} -exec rm -rf {} +`
        );
        console.log('✅ 已清理非保护目录的文件');
      } else {
        await ssh.execCommand(`rm -rf ${envConfig.deployDir}/*`);
      }

      if (protectedDirs.length > 0) {
        const excludeArgs = protectedDirs.map(d => `--exclude='./${d}'`).join(' ');
        await ssh.execCommand(`tar -xzf ${backupFile} ${excludeArgs} -C ${envConfig.deployDir}`);
      } else {
        await ssh.execCommand(`tar -xzf ${backupFile} -C ${envConfig.deployDir}`);
      }
      console.log('✅ 回滚成功');
    } catch (error) {
      console.error('❌ 回滚失败!');
      await ssh.disconnect();
      process.exit(1);
    }

    console.log('\n[步骤 4/4] 验证回滚...');
    try {
      const verifyResult = await ssh.execCommand(`ls -la ${envConfig.deployDir} | head -n 20`);
      console.log('=== 验证回滚后的文件 ===');
      console.log(verifyResult);
      console.log('✅ 验证完成');
    } catch (error) {
      console.error('❌ 验证失败!');
      await ssh.disconnect();
      process.exit(1);
    }

    await ssh.disconnect();

    console.log('\n========================================');
    console.log('✅ 回滚成功完成!');
    console.log(`环境: ${environment}`);
    console.log(`服务器: ${envConfig.sshHost}`);
    console.log(`备份文件: ${backupFile}`);
    console.log('========================================');
  } catch (error) {
    console.error('回滚失败:', error);
    await ssh.disconnect();
    throw error;
  }
}

export default {
  buildProject,
  verifyBuildOutput,
  compressBuild,
  backupExistingDeployment,
  uploadBuild,
  deployAndExtract,
  cleanupFiles,
  deployToServer,
  rollbackDeployment
};