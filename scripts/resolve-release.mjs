import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStoreBuildNumber } from './resolve-store-build-number.mjs';
const buildTargets = ['android-apk', 'android-play', 'ios-adhoc', 'ios-store'];

//#region 构建凭据校验
export function missingConfiguration(env, { target, buildNumber, submit = false, publishApk = false }) {
  const names = ['SOURCE_GIT_URL', 'SOURCE_GIT_USERNAME', 'SOURCE_GIT_TOKEN'];
  if (target.startsWith('android')) names.push('ANDROID_PACKAGE_NAME', 'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD');
  else names.push('IOS_APP_BUNDLE_ID', 'IOS_PROJECT_NAME', 'APPLE_TEAM_ID', 'IOS_DISTRIBUTION_CERT_BASE64', 'IOS_CERT_PASSWORD', target === 'ios-adhoc' ? 'IOS_PROFILE_ADHOC_BASE64' : 'IOS_PROFILE_APP_BASE64');
  if (!buildNumber || submit) names.push(...(target.startsWith('android') ? ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64'] : ['ASC_API_KEY_P8_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID']));
  if (publishApk) {
    if (target !== 'android-apk') throw new Error('只有 android-apk 可以发布到 R2');
    names.push('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_BASE_URL');
  }
  return names.filter(name => !env[name]?.trim());
}

function requireConfiguration(env, options) {
  const missing = missingConfiguration(env, options);
  if (missing.length) throw new Error(`缺少配置：${missing.join(', ')}。见 docs/configuration.md；无商店账号时显式指定 build_number。`);
  validateSourceUrl(env.SOURCE_GIT_URL);
  if (/[\r\n]/.test(env.SOURCE_GIT_USERNAME)) throw new Error('SOURCE_GIT_USERNAME 禁止换行');
}

export function validateSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('SOURCE_GIT_URL 必须是 GitLab HTTPS clone URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/\/.+\/.+/.test(url.pathname)) throw new Error('SOURCE_GIT_URL 须为不含凭据/查询参数的 HTTPS 仓库地址');
  if (url.hostname === 'github.com') throw new Error('源码在 GitLab；SOURCE_GIT_URL 不应指向 GitHub 流水线仓库');
  return url;
}

//#endregion

//#region 发布请求校验
export function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('布尔参数只接受 true/false');
}

export function positiveBuildNumber(value) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number) || number > 2100000000) throw new Error('构建号须为 1..2100000000 的整数');
  return String(number);
}

export function normalizeRequest(event) {
  const input = event.client_payload ?? event.inputs ?? event;
  const sourceRef = input.ref ?? input.tag;
  if (!sourceRef || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(sourceRef) || sourceRef.includes('..')) throw new Error('ref 必须是有效源码 tag/ref/SHA');
  let buildTarget = input.build_target;
  if (!buildTarget && event.action === 'mobile-ios-release') buildTarget = input.distribution === 'ad-hoc' ? 'ios-adhoc' : 'ios-store';
  if (!buildTarget && event.action === 'mobile-android-release') buildTarget = input.artifact_type === 'apk' ? 'android-apk' : 'android-play';
  if (!buildTargets.includes(buildTarget)) throw new Error(`build_target 须为 ${buildTargets.join(', ')}`);
  const tagVersion = sourceRef.match(/^(?:mobile-)?v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1];
  const version = input.version || tagVersion;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version ?? '')) throw new Error('version 须为 X.Y.Z；非版本 tag 必须显式提供 version');
  if (tagVersion && tagVersion !== version) throw new Error('version 与源码 tag 不一致');
  const target = input.target || 'production';
  if (!['internal', 'external', 'production'].includes(target)) throw new Error('target 须为 internal/external/production');
  if (buildTarget.startsWith('ios') && target !== 'production') throw new Error('iOS target=production；Ad Hoc 由 build_target=ios-adhoc 选择');
  const releaseEnv = input.release_env || 'production';
  if (!['test', 'production'].includes(releaseEnv)) throw new Error('release_env 须为 test/production');
  const submit = booleanValue(input.submit);
  const playTrack = input.play_track || 'internal';
  if (!['internal', 'beta', 'production'].includes(playTrack)) throw new Error('play_track 须为 internal/beta/production');
  if (submit && !['android-play', 'ios-store'].includes(buildTarget)) throw new Error('只有 AAB/App Store 商店包可以上传');
  if (submit && buildTarget === 'android-play' && releaseEnv === 'test' && playTrack === 'production') throw new Error('测试后端包不能上传 Play production');
  const offset = String(input.build_number_offset || '0');
  if (!/^(0|[1-9]\d*)$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new Error('build_number_offset 须为非负整数');
  return {
    source_ref: sourceRef, build_target: buildTarget, target, version, release_env: releaseEnv,
    build_number: input.build_number ? positiveBuildNumber(input.build_number) : '',
    build_number_offset: Number(offset),
    publish_apk: booleanValue(input.publish_apk), submit, play_track: playTrack,
  };
}

export async function resolveRelease(event, env = process.env) {
  const request = normalizeRequest(event);
  requireConfiguration(env, { target: request.build_target, buildNumber: request.build_number, publishApk: request.publish_apk, submit: request.submit });
  const platform = request.build_target.startsWith('android') ? 'android' : 'ios';
  const bundleId = platform === 'android' ? env.ANDROID_PACKAGE_NAME : env.IOS_APP_BUNDLE_ID;
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(bundleId)) throw new Error('包名格式不正确');
  const buildNumber = request.build_number || positiveBuildNumber(await resolveStoreBuildNumber({
    platform, offset: request.build_number_offset, env,
  }));
  const artifactType = request.build_target === 'android-apk' ? 'apk' : request.build_target === 'android-play' ? 'aab' : 'ipa';
  return {
    schema: 1, ...request, build_number: buildNumber, platform, artifact_type: artifactType,
    bundle_id: bundleId, source_repository: env.SOURCE_GIT_URL,
    artifact_name: `mobile-${request.version}-${buildNumber}-${request.release_env}-${request.build_target}-${request.target}.${artifactType}`,
    artifact_group: `mobile-${env.GITHUB_RUN_ID || 'local'}`,
    gradle_task: artifactType === 'apk' ? 'assembleRelease' : 'bundleRelease',
    public_env: { EXPO_PUBLIC_APP_CHANNEL: 'production', EXPO_PUBLIC_RELEASE_ENV: request.release_env },
    run_id: env.GITHUB_RUN_ID || 'local', pipeline_sha: env.GITHUB_SHA || '', actor: env.GITHUB_ACTOR || '',
  };
}
//#endregion

async function main() {
  const release = await resolveRelease(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  mkdirSync('.private', { recursive: true });
  writeFileSync('.private/release.json', `${JSON.stringify(release, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    // 包名来自 Secret，由构建 job 自行读取，避免整份 output 被 GitHub 的脱敏规则丢弃。
    const { bundle_id, ...publicRelease } = release;
    const outputs = { release_json: JSON.stringify(publicRelease), build_target: release.build_target, source_ref: release.source_ref, platform: release.platform, artifact_group: release.artifact_group, publish_apk: release.publish_apk, submit: release.submit };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(''));
  }
  console.log(`[release] ${release.build_target} ${release.version} (${release.build_number}) ${release.release_env}; submit=${release.submit}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
