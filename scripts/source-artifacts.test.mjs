import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareSource, validateExpoConfig, prepareNativeProject } from './prepare-source.mjs';
import { checkoutSource } from './checkout-source.mjs';
import { readArtifact, sha256, verifySigningIdentity } from './artifacts.mjs';

test('无需品牌配置文件，只同步版本并保留源码中的名称、scheme 和服务地址', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-source-'));
  try {
    const app = path.join(root, 'apps/mobile');
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'package.json'), '{"version":"1.4.0"}');
    const original = "const config = {version: '1.4.0', name: 'Team App', scheme: ['team-app'], extra: {apiBaseUrl: 'https://api.team.example'}};\nexport default config;\n";
    writeFileSync(path.join(app, 'app.config.ts'), original);
    const release = { version: '1.4.1', build_number: '101', platform: 'ios', bundle_id: 'com.example.mobile', release_env: 'test' };
    prepareSource(root, release, {});
    assert.equal(JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).version, '1.4.1');
    const contents = readFileSync(path.join(app, 'app.config.ts'), 'utf8');
    assert.equal(contents, original.replace("version: '1.4.0'", "version: '1.4.1'"));
    assert.equal(existsSync(path.join(app, 'ci-build-config.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Firebase 恢复前核对包名，不改写源码配置', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-brand-'));
  try {
    const app = path.join(root, 'apps/mobile');
    mkdirSync(app, { recursive: true });
    const original = "const config = {version: '1.4.1'};\nexport default config;\n";
    writeFileSync(path.join(app, 'app.config.ts'), original);
    writeFileSync(path.join(app, 'package.json'), '{"version":"1.4.1"}');
    const release = { platform: 'android', version: '1.4.1', bundle_id: 'com.example.mobile' };
    const services = packageName => Buffer.from(JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: packageName } } }] })).toString('base64');
    assert.throws(() => prepareSource(root, release, { GOOGLE_SERVICES_PROD_JSON_BASE64: services('com.other.mobile') }), /包名与本次构建不一致/);
    assert.equal(existsSync(path.join(app, 'secrets/google-services-prod.json')), false);
    prepareSource(root, release, { GOOGLE_SERVICES_PROD_JSON_BASE64: services(release.bundle_id) });
    assert.equal(existsSync(path.join(app, 'secrets/google-services-prod.json')), true);
    assert.equal(readFileSync(path.join(app, 'app.config.ts'), 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('上传前对真实文件验 SHA256/大小，拒绝改包和路径穿越', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-artifact-'));
  try {
    const file = path.join(root, 'mobile.aab');
    writeFileSync(file, 'fixture-binary');
    const manifest = { schema: 1, bundle_id: 'com.example.mobile', artifact_name: 'mobile.aab', bytes: 14, sha256: sha256(file), source_sha: 'a'.repeat(40), pipeline_sha: 'b'.repeat(40) };
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    assert.equal(readArtifact(root, manifest.bundle_id).file, file);
    assert.throws(() => readArtifact(root, 'com.other.mobile'), /包名与本次构建不一致/);
    writeFileSync(file, 'tampered-binary');
    assert.throws(() => readArtifact(root, manifest.bundle_id), /不一致/);
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest, artifact_name: '../mobile.aab' }));
    assert.throws(() => readArtifact(root, manifest.bundle_id), /非法产物/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('iOS 签名清理恢复完整 keychain 列表并保留空格路径，不只恢复默认项', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-keychain-'));
  try {
    const signing = path.join(root, '.private/signing');
    const bin = path.join(root, 'bin');
    mkdirSync(signing, { recursive: true });
    mkdirSync(bin);
    const keychains = ['/Users/runner/Library/Keychains/login.keychain-db', '/Users/runner/Library/Keychains/Customer Signing.keychain-db'];
    writeFileSync(path.join(signing, 'previous-keychain'), keychains[0]);
    writeFileSync(path.join(signing, 'previous-keychains.json'), JSON.stringify(keychains));
    writeFileSync(path.join(signing, 'keychain-path'), '/tmp/mobile-signing.keychain-db');
    const profile = path.join(root, 'existing.mobileprovision');
    writeFileSync(profile, 'ci-profile');
    writeFileSync(path.join(signing, 'installed-profile'), profile);
    writeFileSync(path.join(signing, 'previous-profile.mobileprovision'), 'previous-customer-profile');
    writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o700 });
    writeFileSync(path.join(bin, 'security'), '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SECURITY_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n', { mode: 0o700 });
    const log = path.join(root, 'security.log');
    execFileSync('bash', [path.resolve('scripts/install-ios-signing.sh'), 'cleanup'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SECURITY_LOG: log } });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.find(args => args[0] === 'list-keychains'), ['list-keychains', '-d', 'user', '-s', ...keychains]);
    assert.ok(calls.some(args => args[0] === 'delete-keychain'));
    assert.equal(readFileSync(profile, 'utf8'), 'previous-customer-profile');
    assert.throws(() => readFileSync(path.join(signing, 'keychain-path')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const sourceUrl = 'https://gitlab.customer.example/customer/subgroup/mobile.git';
const token = 'fixture-private-token';

test('GitLab checkout 用 askpass，remote/argv/脚本不写 token，并关闭 trace 和 TLS 绕过', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-git-'));
  try {
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args });
      assert.ok(!JSON.stringify(args).includes(token));
      assert.ok(!readFileSync(options.env.GIT_ASKPASS, 'utf8').includes(token));
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(options.env.GIT_TRACE, undefined);
      assert.equal(options.env.GIT_CURL_VERBOSE, undefined);
      assert.equal(options.env.GIT_SSL_NO_VERIFY, undefined);
      assert.equal(options.env.SOURCE_GIT_TOKEN, token);
    };
    checkoutSource('mobile-v1.4.1', { SOURCE_GIT_URL: sourceUrl, SOURCE_GIT_USERNAME: 'gitlab+deploy-token-1', SOURCE_GIT_TOKEN: token, GIT_TRACE: '1', GIT_CURL_VERBOSE: '1', GIT_SSL_NO_VERIFY: '1' }, { root, run });
    assert.ok(calls.some(call => call.args.includes(sourceUrl)));
    assert.ok(calls.some(call => call.args.includes('http.sslVerify=true')));
    assert.equal(existsSync(path.join(root, '.private/git-askpass.sh')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitLab checkout 拒绝带凭据 URL、恶意 ref 和已有源码目录', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-git-invalid-'));
  const env = { SOURCE_GIT_URL: sourceUrl, SOURCE_GIT_USERNAME: 'oauth2', SOURCE_GIT_TOKEN: token };
  try {
    assert.throws(() => checkoutSource('main', { ...env, SOURCE_GIT_URL: 'https://oauth2:token@gitlab.customer.example/customer/mobile.git' }, { root }), /不含凭据/);
    assert.throws(() => checkoutSource('--upload-pack=bad', env, { root }), /非法源码 ref/);
    mkdirSync(path.join(root, 'source'));
    assert.throws(() => checkoutSource('main', env, { root }), /拒绝覆盖/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('私有 CA 配置传入 Git 与后续 Node，获取失败仍清理 askpass', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-git-ca-'));
  const env = { SOURCE_GIT_URL: sourceUrl, SOURCE_GIT_USERNAME: 'oauth2', SOURCE_GIT_TOKEN: token, GITHUB_ENV: path.join(root, 'github-env'), SOURCE_GIT_CA_CERT_BASE64: Buffer.from('-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----').toString('base64') };
  try {
    assert.throws(() => checkoutSource('main', env, { root, run: (_command, _args, options) => { assert.match(readFileSync(options.env.GIT_SSL_CAINFO, 'utf8'), /BEGIN CERTIFICATE/); throw new Error('fixture fetch denied'); } }), /fetch denied/);
    assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), /NODE_EXTRA_CA_CERTS=/);
    assert.equal(existsSync(path.join(root, '.private/git-askpass.sh')), false);
    assert.throws(() => checkoutSource('main', { ...env, SOURCE_GIT_CA_CERT_BASE64: Buffer.from('invalid').toString('base64') }, { root }), /不是 PEM/);
    assert.equal(existsSync(path.join(root, '.private/git-askpass.sh')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('签名证据必须匹配 Android 指纹或 Apple Distribution Team', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(verifySigningIdentity('android', `Signer #1 certificate SHA-256 digest: ${digest}`, digest), digest);
  assert.equal(verifySigningIdentity('android', `SHA256: ${Array(32).fill('AB').join(':')}`, digest), digest);
  assert.throws(() => verifySigningIdentity('android', `SHA256: ${digest}`, 'cd'.repeat(32)), /keystore 不一致/);
  assert.equal(verifySigningIdentity('ios', 'Authority=Apple Distribution: Mobile\nTeamIdentifier=TEAM123456', 'TEAM123456'), 'TEAM123456');
  assert.throws(() => verifySigningIdentity('ios', 'Authority=Apple Development: Mobile\nTeamIdentifier=TEAM123456', 'TEAM123456'), /Distribution 签名/);
  assert.throws(() => verifySigningIdentity('ios', 'Authority=Apple Distribution: Mobile\nTeamIdentifier=OTHER12345', 'TEAM123456'), /团队/);
});


test('Expo 配置核验支持 scheme 数组和两端独立包名，拒绝环境或签名身份错配', () => {
  const release = { platform: 'ios', version: '1.4.1', build_number: '101', bundle_id: 'com.example.mobile', release_env: 'production' };
  const config = { name: 'Team App', version: '1.4.1', scheme: ['team-app'], ios: { bundleIdentifier: release.bundle_id }, android: { package: 'com.example.android' }, updates: { enabled: false }, extra: { releaseEnv: 'production', apiBaseUrl: 'https://api.team.example' } };
  validateExpoConfig(config, release);
  assert.throws(() => validateExpoConfig({ ...config, ios: { ...config.ios, bundleIdentifier: 'com.other.mobile' } }, release), /bundleIdentifier/);
  validateExpoConfig(config, { ...release, platform: 'android', bundle_id: config.android.package });
  assert.throws(() => validateExpoConfig({ ...config, extra: { ...config.extra, releaseEnv: 'test' } }, release), /releaseEnv/);
  assert.throws(() => validateExpoConfig({ ...config, updates: { enabled: true } }, release), /OTA/);
  for (const apiBaseUrl of ['http://api.team.example', 'https://user:pass@api.team.example', 'https://api.team.example/api', 'https://api.team.example\n']) {
    assert.throws(() => validateExpoConfig({ ...config, extra: { ...config.extra, apiBaseUrl } }, release));
  }
});

test('prebuild 后 Android 原生版本同步，格式漂移或错误包名时停止', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-native-version-'));
  try {
    mkdirSync(path.join(root, 'android/app'), { recursive: true });
    const file = path.join(root, 'android/app/build.gradle');
    const release = { platform: 'android', version: '1.4.1', build_number: '101', bundle_id: 'com.example.mobile' };
    writeFileSync(file, 'defaultConfig { applicationId "com.example.mobile"; versionName "1.4.0"; versionCode 1 }');
    prepareNativeProject(root, release);
    assert.match(readFileSync(file, 'utf8'), /versionName "1.4.1"; versionCode 101/);
    writeFileSync(file, 'defaultConfig { applicationId "wrong.mobile"; versionName "1.4.0"; versionCode 1 }');
    assert.throws(() => prepareNativeProject(root, release), /applicationId/);
    writeFileSync(file, 'defaultConfig { versionName project.version; versionCode 1 }');
    assert.throws(() => prepareNativeProject(root, release), /格式变化/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
