import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSourceUrl } from './resolve-release.mjs';

//#region GitLab 只读源码获取
export function checkoutSource(sourceRef, env = process.env, { root = process.cwd(), run = execFileSync } = {}) {
  const sourceUrl = validateSourceUrl(env.SOURCE_GIT_URL).href;
  if (!env.SOURCE_GIT_TOKEN || !env.SOURCE_GIT_USERNAME || /[\r\n]/.test(env.SOURCE_GIT_USERNAME)) throw new Error('缺少 GitLab 只读 token/username');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(sourceRef ?? '') || sourceRef.includes('..')) throw new Error('非法源码 ref');
  const source = path.resolve(root, 'source');
  if (existsSync(source)) throw new Error('source 已存在，拒绝覆盖工作目录');
  const privateRoot = path.resolve(root, '.private');
  mkdirSync(privateRoot, { recursive: true });
  const askpass = path.join(privateRoot, 'git-askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s" "$SOURCE_GIT_USERNAME" ;;\n  *Password*) printf "%s" "$SOURCE_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
  const gitEnv = { ...env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE' || key === 'GIT_SSL_NO_VERIFY') delete gitEnv[key];
  try {
    if (env.SOURCE_GIT_CA_CERT_BASE64) {
      const ca = Buffer.from(env.SOURCE_GIT_CA_CERT_BASE64, 'base64').toString('utf8');
      if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('SOURCE_GIT_CA_CERT_BASE64 不是 PEM 证书');
      const file = path.join(privateRoot, 'source-git-ca.pem');
      writeFileSync(file, ca, { mode: 0o600 });
      gitEnv.GIT_SSL_CAINFO = file;
      if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `NODE_EXTRA_CA_CERTS=${file}\n`);
    }
    run('git', ['init', source], { env: gitEnv, stdio: 'inherit' });
    run('git', ['-C', source, 'remote', 'add', 'origin', sourceUrl], { env: gitEnv, stdio: 'inherit' });
    run('git', ['-C', source, '-c', 'credential.helper=', '-c', 'http.sslVerify=true', 'fetch', '--no-tags', '--depth=1', 'origin', sourceRef], { env: gitEnv, stdio: 'inherit', timeout: 300000 });
    run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD'], { env: gitEnv, stdio: 'inherit' });
  } finally { rmSync(askpass, { force: true }); }
  console.log('[source] GitLab ref 已取得；token 没有写入 remote URL 或文件');
}
//#endregion

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { checkoutSource(process.env.MOBILE_SOURCE_REF); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
