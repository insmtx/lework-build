import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateManagedAppVersion } from './update-managed-app-version.mjs';

//#region 源码版本与运行文件
export function prepareSource(sourceRoot, release, env = process.env) {
  const root = path.resolve(sourceRoot);
  const app = path.join(root, 'apps/mobile');
  updateManagedAppVersion({ root: app, version: release.version });
  if (env.GOOGLE_SERVICES_PROD_JSON_BASE64 && release.platform === 'android') {
    const services = JSON.parse(Buffer.from(env.GOOGLE_SERVICES_PROD_JSON_BASE64, 'base64').toString('utf8'));
    if (!(services.client ?? []).some(client => client.client_info?.android_client_info?.package_name === release.bundle_id)) throw new Error('Firebase 文件包名与本次构建不一致');
    mkdirSync(path.join(app, 'secrets'), { recursive: true });
    writeFileSync(path.join(app, 'secrets/google-services-prod.json'), JSON.stringify(services));
  }
  return app;
}
//#endregion

//#region 构建配置核验与原生版本
export function validateExpoConfig(config, release) {
  const bundleField = release.platform === 'ios' ? 'ios.bundleIdentifier' : 'android.package';
  const bundleId = release.platform === 'ios' ? config.ios?.bundleIdentifier : config.android?.package;
  for (const [label, actual, expected] of [
    ['version', config.version, release.version],
    [bundleField, bundleId, release.bundle_id],
    ['releaseEnv', config.extra?.releaseEnv, release.release_env],
  ]) {
    if (actual !== expected) throw new Error(`${label} 与发布请求不一致`);
  }
  const apiBaseUrl = config.extra?.apiBaseUrl;
  const api = new URL(apiBaseUrl);
  if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash || /[\r\n]/.test(apiBaseUrl)) throw new Error('源码 apiBaseUrl 必须为不含凭据和 /api 的 HTTPS origin');
  if (config.updates?.enabled === true) throw new Error('当前流水线未接入 OTA 发布，请先在源码中关闭 updates');
  console.log('[config] 源码包名、版本及后端环境校验通过');
}

export function prepareNativeProject(app, release, env = process.env) {
  if (release.platform === 'android') {
    const file = path.join(app, 'android/app/build.gradle');
    const text = readFileSync(file, 'utf8');
    const fields = [
      [/versionName\s+["'][^"']+["']/g, `versionName "${release.version}"`],
      [/versionCode\s+\d+/g, `versionCode ${release.build_number}`],
    ];
    let next = text;
    for (const [pattern, value] of fields) {
      if ((next.match(pattern) ?? []).length !== 1) throw new Error('Android 版本字段格式变化');
      next = next.replace(pattern, value);
    }
    if (!next.includes(`applicationId '${release.bundle_id}'`) && !next.includes(`applicationId "${release.bundle_id}"`)) throw new Error('Android applicationId 不匹配');
    writeFileSync(file, next);
  } else {
    const ios = path.join(app, 'ios');
    const projects = readdirSync(ios).filter(name => name.endsWith('.xcodeproj'));
    const projectName = env.IOS_PROJECT_NAME;
    if (projects.length !== 1 || projects[0] !== `${projectName}.xcodeproj`) throw new Error('生成的 Xcode 项目名与 IOS_PROJECT_NAME 不一致');
    const project = path.join(ios, projects[0], 'project.pbxproj');
    let contents = readFileSync(project, 'utf8');
    for (const [pattern, value] of [
      [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${release.version};`],
      [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${release.build_number};`],
    ]) {
      if (!pattern.test(contents)) throw new Error('Xcode 原生版本字段缺失');
      contents = contents.replace(pattern, value);
    }
    writeFileSync(project, contents);
    const info = path.join(ios, projectName, 'Info.plist');
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${release.version}`, info]);
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${release.build_number}`, info]);
  }
  console.log(`[version] 原生 ${release.platform} 版本已设置为 ${release.version} (${release.build_number})`);
}
//#endregion

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const release = JSON.parse(readFileSync('.private/release.json', 'utf8'));
  const mode = process.argv[2] || 'apply';
  if (mode === 'validate') {
    validateExpoConfig(JSON.parse(readFileSync('.private/expo-config.json', 'utf8')), release);
  } else if (mode === 'native') {
    prepareNativeProject(path.resolve('source/apps/mobile'), release);
  } else if (mode === 'apply') {
    release.source_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: 'source', encoding: 'utf8' }).trim();
    prepareSource('source', release);
    writeFileSync('.private/release.json', `${JSON.stringify(release, null, 2)}\n`);
    appendFileSync(process.env.GITHUB_ENV, Object.entries(release.public_env).map(([name, value]) => `${name}=${value}\n`).join(''));
    appendFileSync(process.env.GITHUB_ENV, `MOBILE_VERSION=${release.version}\nMOBILE_BUILD_NUMBER=${release.build_number}\nMOBILE_ARTIFACT_NAME=${release.artifact_name}\nMOBILE_BUNDLE_ID=${release.bundle_id}\nMOBILE_GRADLE_TASK=${release.gradle_task}\nMOBILE_BUILD_TARGET=${release.build_target}\nMOBILE_RELEASE_ENV=${release.release_env}\nMOBILE_PLAY_TRACK=${release.play_track}\nMOBILE_SOURCE_SHA=${release.source_sha}\n`);
  } else throw new Error('用法：prepare-source.mjs [apply|validate|native]');
}
