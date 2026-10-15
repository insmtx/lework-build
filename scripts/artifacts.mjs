import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const toolchain = JSON.parse(readFileSync(new URL('./toolchain.json', import.meta.url), 'utf8'));

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readArtifact(directory = 'dist', expectedBundleId = process.env.MOBILE_BUNDLE_ID) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (!expectedBundleId || manifest.schema !== 1 || manifest.bundle_id !== expectedBundleId) throw new Error('产物包名与本次构建不一致');
  if (!/^[A-Za-z0-9_.-]+$/.test(manifest.artifact_name ?? '') || path.basename(manifest.artifact_name) !== manifest.artifact_name) throw new Error('非法产物文件名');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) throw new Error('产物缺少 SHA256');
  if (!/^[a-f0-9]{40}$/.test(manifest.source_sha ?? '') || !/^[a-f0-9]{40}$/.test(manifest.pipeline_sha ?? '')) throw new Error('产物缺少源码/流水线精确 SHA');
  const file = path.join(root, manifest.artifact_name);
  if (sha256(file) !== manifest.sha256 || statSync(file).size !== manifest.bytes) throw new Error('产物 SHA256/大小与构建清单不一致');
  return { manifest, file };
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

//#region 二进制身份与签名验证
export function verifySigningIdentity(platform, report, expected) {
  if (platform === 'ios') {
    const team = report.match(/^TeamIdentifier=(\S+)$/m)?.[1];
    if (!expected || team !== expected || !/^Authority=(?:Apple|iPhone) Distribution:/m.test(report)) throw new Error('IPA 不是团队的 Distribution 签名');
    return team;
  }
  const fingerprint = report.match(/certificate SHA-256 digest:\s*([a-f0-9]{64})/i)?.[1] || report.match(/SHA256:\s*([a-f0-9:]{64,95})/i)?.[1];
  const normalize = value => String(value ?? '').replace(/:/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalize(expected)) || normalize(fingerprint) !== normalize(expected)) throw new Error('Android 产物签名证书与 keystore 不一致');
  return normalize(fingerprint);
}

function verifyBinary(file, release) {
  run('unzip', ['-t', file]);
  let identity;
  let signature;
  if (release.artifact_type === 'ipa') {
    const temporary = mkdtempSync(path.join(tmpdir(), 'mobile-ipa-'));
    try {
      run('unzip', ['-q', file, '-d', temporary]);
      const apps = readdirSync(path.join(temporary, 'Payload')).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw new Error('IPA 必须包含唯一主应用');
      const app = path.join(temporary, 'Payload', apps[0]);
      const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]));
      identity = { bundleId: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString, buildNumber: plist.CFBundleVersion };
      run('codesign', ['--verify', '--deep', '--strict', app]);
      const details = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
      if (details.error || details.status !== 0) throw new Error('读取 IPA 签名详情失败');
      signature = `${details.stdout ?? ''}${details.stderr ?? ''}`.trim();
      verifySigningIdentity('ios', signature, process.env.APPLE_TEAM_ID);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } else if (release.artifact_type === 'apk') {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    const builds = readdirSync(path.join(sdk, 'build-tools')).filter(name => /^\d/.test(name)).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    signature = run(path.join(sdk, 'build-tools', builds.at(-1), 'apksigner'), ['verify', '--print-certs', file]);
    const analyzer = path.join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
    identity = {
      bundleId: run(analyzer, ['manifest', 'application-id', file]),
      version: run(analyzer, ['manifest', 'version-name', file]),
      buildNumber: run(analyzer, ['manifest', 'version-code', file]),
    };
  } else {
    signature = run('jarsigner', ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', file]);
    if (!signature.includes('jar verified')) throw new Error('AAB 缺少有效 JAR 签名');
    signature += `\n${run('keytool', ['-J-Duser.language=en', '-J-Duser.country=US', '-printcert', '-jarfile', file])}`;
    const bundletool = path.resolve('.private/bundletool.jar');
    if (!existsSync(bundletool)) {
      run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--connect-timeout', '30', '--max-time', '300', `https://github.com/google/bundletool/releases/download/${toolchain.bundletool}/bundletool-all-${toolchain.bundletool}.jar`, '-o', bundletool]);
    }
    if (sha256(bundletool) !== toolchain.bundletoolSha256) throw new Error('bundletool SHA256 不匹配');
    const dump = expression => run('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle', file, '--xpath', expression]).replace(/^"|"$/g, '');
    identity = { bundleId: dump('/manifest/@package'), version: dump('/manifest/@android:versionName'), buildNumber: dump('/manifest/@android:versionCode') };
  }
  if (release.platform === 'android') {
    if (!process.env.ANDROID_KEYSTORE_PASSWORD || !process.env.ANDROID_KEY_ALIAS) throw new Error('验证产物签名需要 keystore 密码和 alias');
    const certificate = run('keytool', ['-J-Duser.language=en', '-J-Duser.country=US', '-list', '-v', '-keystore', path.resolve('source/apps/mobile/android/app/ci-upload.keystore'), '-alias', process.env.ANDROID_KEY_ALIAS, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD']);
    verifySigningIdentity('android', signature, certificate.match(/SHA256:\s*([a-f0-9:]{64,95})/i)?.[1]);
  }
  if (identity.bundleId !== release.bundle_id || identity.version !== release.version || String(identity.buildNumber) !== release.build_number) throw new Error('最终二进制身份/版本/构建号与请求不一致');
  return { identity, signature };
}
//#endregion

export function collectArtifact() {
  const release = JSON.parse(readFileSync('.private/release.json', 'utf8'));
  const directory = release.platform === 'ios' ? '.private/ios-output' : `source/apps/mobile/android/app/build/outputs/${release.artifact_type === 'apk' ? 'apk' : 'bundle'}/release`;
  const files = readdirSync(directory).filter(name => name.endsWith(`.${release.artifact_type}`));
  if (files.length !== 1) throw new Error('预期构建唯一产物，不能选择不确定的第一个文件');
  const source = path.resolve(directory, files[0]);
  const evidence = verifyBinary(source, release);
  mkdirSync('dist', { recursive: true });
  const output = path.join('dist', release.artifact_name);
  copyFileSync(source, output);
  const { source_repository, public_env, ...provenance } = release;
  const manifest = { ...provenance, sha256: sha256(output), bytes: statSync(output).size, created_at: new Date().toISOString(), binary_identity: evidence.identity, signing_verified: true };
  writeFileSync('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync('dist/signature.txt', `${evidence.signature}\n`);
  writeFileSync('dist/SHA256SUMS', `${manifest.sha256}  ${release.artifact_name}\n`);
  console.log(`[artifact] ${release.artifact_name} SHA256=${manifest.sha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === 'collect') collectArtifact();
  else throw new Error('用法：node scripts/artifacts.mjs collect');
}
