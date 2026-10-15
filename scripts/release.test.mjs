import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { missingConfiguration } from './resolve-release.mjs';
import { normalizeRequest, resolveRelease, positiveBuildNumber, booleanValue } from './resolve-release.mjs';
import { r2Keys } from './upload-r2-artifact.mjs';

function environment() {
  const names = new Set(['android-apk', 'android-play', 'ios-adhoc', 'ios-store'].flatMap(target => missingConfiguration({}, { target, buildNumber: '', publishApk: target === 'android-apk' })));
  const env = Object.fromEntries([...names].map(name => [name, 'fixture-value']));
  env.SOURCE_GIT_URL = 'https://gitlab.customer.example/group/mobile-source.git';
  env.SOURCE_GIT_USERNAME = 'gitlab+deploy-token-1';
  env.R2_PUBLIC_BASE_URL = 'https://cdn.customer.example';
  env.ANDROID_PACKAGE_NAME = 'com.example.mobile';
  env.IOS_APP_BUNDLE_ID = 'com.example.mobile.ios';
  env.IOS_PROJECT_NAME = 'Mobile';
  env.GITHUB_RUN_ID = '38272170658';
  env.GITHUB_SHA = 'a'.repeat(40);
  return env;
}
const request = { ref: 'mobile-v1.4.1', build_target: 'android-apk', build_number: '101' };

test('四个构建目标使用同一语义版本，包名按平台读取', async () => {
  for (const target of ['android-apk', 'android-play', 'ios-adhoc', 'ios-store']) {
    const release = await resolveRelease({ ...request, build_target: target }, environment());
    assert.equal(release.version, '1.4.1');
    assert.equal(release.build_number, '101');
    assert.equal(release.bundle_id, target.startsWith('ios') ? 'com.example.mobile.ios' : 'com.example.mobile');
    assert.match(release.artifact_name, new RegExp(`mobile-1.4.1-101-production-${target}`));
    assert.equal(release.public_env.EXPO_PUBLIC_APP_CHANNEL, 'production');
    assert.equal(release.artifact_group, 'mobile-38272170658');
  }
});
test('兼容标准 repository_dispatch 的 Android/iOS 事件字段', () => {
  assert.equal(normalizeRequest({ action: 'mobile-android-release', client_payload: { ref: request.ref, artifact_type: 'apk' } }).build_target, 'android-apk');
  assert.equal(normalizeRequest({ action: 'mobile-ios-release', client_payload: { ref: request.ref } }).build_target, 'ios-store');
});
test('生产渠道可以编入 test 后端，保留原版渠道/后端分离语义', async () => {
  const release = await resolveRelease({ ...request, release_env: 'test' }, environment());
  assert.equal(release.public_env.EXPO_PUBLIC_APP_CHANNEL, 'production');
  assert.equal(release.public_env.EXPO_PUBLIC_RELEASE_ENV, 'test');
  assert.deepEqual(release.public_env, { EXPO_PUBLIC_APP_CHANNEL: 'production', EXPO_PUBLIC_RELEASE_ENV: 'test' });
  assert.match(release.artifact_name, /-test-/);
});
test('tag 版本和显式版本冲突时拒绝；branch 必须显式版本', () => {
  assert.throws(() => normalizeRequest({ ...request, version: '1.4.2' }), /不一致/);
  assert.throws(() => normalizeRequest({ ...request, ref: 'main' }), /version/);
  assert.equal(normalizeRequest({ ...request, ref: 'main', version: '1.4.1' }).version, '1.4.1');
});
test('输入不能进入 shell、越界构建号和非布尔值被拒绝', () => {
  for (const ref of ['--option', 'main\nmalicious', 'a..b', '$(touch bad)', '`touch bad`']) assert.throws(() => normalizeRequest({ ...request, ref }));
  for (const value of ['0', '-1', '2147483647', '1e3', '1\n2']) assert.throws(() => positiveBuildNumber(value));
  assert.equal(booleanValue('false', true), false);
  assert.throws(() => booleanValue('yes'));
});
test('显式构建号不要求 Play/ASC 凭据；自动号列出对应缺失配置', async () => {
  const env = environment();
  delete env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64;
  assert.equal((await resolveRelease(request, env)).build_number, '101');
  await assert.rejects(resolveRelease({ ...request, build_number: '' }, env), /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64/);
  assert.ok(missingConfiguration({}, { target: 'ios-adhoc', buildNumber: '1' }).includes('IOS_PROFILE_ADHOC_BASE64'));
  assert.ok(!missingConfiguration({}, { target: 'ios-adhoc', buildNumber: '1' }).includes('IOS_PROFILE_APP_BASE64'));
});
test('自动 Android 商店最大构建号加一并应用 offset', async () => {
  const release = await resolveRelease({ ...request, build_number: '', build_number_offset: '2' }, { ...environment(), STORE_ANDROID_TRACKS_JSON: JSON.stringify({ tracks: [{ releases: [{ versionCodes: ['90', '100'] }] }] }) });
  assert.equal(release.build_number, '103');
});
test('自动 iOS 查询全部构建，忽略非数字版本', async () => {
  const release = await resolveRelease({ ...request, build_target: 'ios-store', build_number: '' }, { ...environment(), STORE_IOS_BUILDS_JSON: JSON.stringify({ data: [{ attributes: { version: '80' } }, { attributes: { version: '83' } }] }) });
  assert.equal(release.build_number, '84');
});
test('R2 test/production 固定 latest 分目录，使用通用文件名', () => {
  const base = { artifact_type: 'apk', version: '1.4.1', build_number: '101' };
  const production = r2Keys({ ...base, release_env: 'production' });
  const testKeys = r2Keys({ ...base, release_env: 'test' });
  assert.equal(production.latest, 'mobile/appUpdate/production/mobile_Android_latest.apk');
  assert.notEqual(production.latest, testKeys.latest);
  assert.throws(() => r2Keys({ ...base, release_env: 'production' }, '../bad'));
});
test('同一次构建可显式上传商店，默认关闭且拒绝不适用的包和轨道', () => {
  assert.equal(normalizeRequest(request).submit, false);
  assert.equal(normalizeRequest({ ...request, build_target: 'android-play', submit: true }).submit, true);
  assert.equal(normalizeRequest({ ...request, build_target: 'ios-store', submit: true }).submit, true);
  assert.throws(() => normalizeRequest({ ...request, submit: true }), /商店包/);
  assert.throws(() => normalizeRequest({ ...request, build_target: 'ios-adhoc', submit: true }), /商店包/);
  assert.throws(() => normalizeRequest({ ...request, build_target: 'android-play', release_env: 'test', play_track: 'production', submit: true }), /测试后端/);
  assert.throws(() => normalizeRequest({ ...request, play_track: 'unsafe-track' }), /play_track/);
});


test('即便手工填写构建号，开启商店上传仍必须提供对应凭据', async () => {
  const env = environment();
  delete env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64;
  await assert.rejects(resolveRelease({ ...request, build_target: 'android-play', submit: true }, env), /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64/);
  delete env.ASC_KEY_ID;
  await assert.rejects(resolveRelease({ ...request, build_target: 'ios-store', submit: true }, env), /ASC_KEY_ID/);
});


test('Android 首包只要求源码访问、包名和签名，不要求 iOS 或应用展示配置', async () => {
  const env = environment();
  for (const name of Object.keys(env)) if (name.startsWith('IOS_') || name.startsWith('ASC_') || name === 'APPLE_TEAM_ID') delete env[name];
  assert.deepEqual(missingConfiguration(env, { target: 'android-apk', buildNumber: '101' }), []);
  const release = await resolveRelease(request, env);
  assert.equal(release.bundle_id, env.ANDROID_PACKAGE_NAME);
  assert.deepEqual(release.public_env, { EXPO_PUBLIC_APP_CHANNEL: 'production', EXPO_PUBLIC_RELEASE_ENV: 'production' });
});


test('缺少对应平台包名时停止，iOS 工程名仅在 iOS 构建时需要', async () => {
  const env = environment();
  delete env.ANDROID_PACKAGE_NAME;
  await assert.rejects(resolveRelease(request, env), /ANDROID_PACKAGE_NAME/);
  delete env.IOS_PROJECT_NAME;
  await assert.rejects(resolveRelease({ ...request, build_target: 'ios-store' }, env), /IOS_PROJECT_NAME/);
});

test('跨 job 的发布参数不携带包名 Secret，本地清单保留签名核对所需包名', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-release-output-'));
  try {
    const event = path.join(root, 'event.json');
    const output = path.join(root, 'github-output');
    writeFileSync(event, JSON.stringify(request));
    execFileSync(process.execPath, [path.resolve('scripts/resolve-release.mjs')], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, ...environment(), GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
    });
    const contents = readFileSync(output, 'utf8');
    assert.ok(!contents.includes(environment().ANDROID_PACKAGE_NAME));
    const release = JSON.parse(contents.split('\n').find(line => line.startsWith('release_json=')).slice('release_json='.length));
    assert.equal(release.bundle_id, undefined);
    assert.equal(release.platform, 'android');
    assert.equal(JSON.parse(readFileSync(path.join(root, '.private/release.json'), 'utf8')).bundle_id, environment().ANDROID_PACKAGE_NAME);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
