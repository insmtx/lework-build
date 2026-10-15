#!/usr/bin/env node

import { createSign } from 'node:crypto';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ASC_AUDIENCE = 'appstoreconnect-v1';
const ASC_API_BASE_URL = 'https://api.appstoreconnect.apple.com';

function fail(message) {
  console.error(`[store-build-number] ${message}`);
  process.exit(1);
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to auto resolve build_number`);
  }
  return value;
}

function requireEnvGroup(env, names) {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required to auto resolve build_number`);
  }
}

function parseNonNegativeInteger(value, label) {
  const raw = String(value ?? '0').trim() || '0';
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${label} must be a non-negative integer, got "${value}"`);
  }
  return Number(raw);
}

function parsePositiveInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return Number(raw);
}

export function maxAndroidVersionCodeFromTracks(payload) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const versionCodes = tracks.flatMap((track) => (
    Array.isArray(track?.releases)
      ? track.releases.flatMap((release) => release?.versionCodes ?? [])
      : []
  ));

  const numbers = versionCodes
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);

  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

export function maxIosBuildNumberFromBuilds(payload, logger = console) {
  const builds = Array.isArray(payload?.data) ? payload.data : [];
  const numbers = [];

  for (const build of builds) {
    const value = build?.attributes?.version;
    const text = String(value ?? '').trim();
    if (/^[1-9]\d*$/.test(text)) {
      numbers.push(Number(text));
      continue;
    }
    if (text) {
      logger.warn(`[store-build-number] Ignoring non-numeric iOS build version: ${text}`);
    }
  }

  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

function signJwt({ header, payload, privateKey, algorithm, dsaEncoding }) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign(algorithm);
  signer.update(input);
  signer.end();
  const signature = signer.sign(dsaEncoding ? { key: privateKey, dsaEncoding } : privateKey);
  return `${input}.${base64Url(signature)}`;
}

async function requestJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  const payload = text ? parseJson(text, label) : {};
  if (!response.ok) {
    const message = payload?.error_description || payload?.error?.message || payload?.errors?.[0]?.detail || text;
    throw new Error(`${label} failed (${response.status}): ${message}`);
  }
  return payload;
}

async function getGoogleAccessToken(fetchImpl, serviceAccount) {
  const clientEmail = serviceAccount.client_email;
  const privateKey = serviceAccount.private_key;
  const tokenUri = serviceAccount.token_uri || GOOGLE_TOKEN_URI;
  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64 must contain client_email and private_key');
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    header: { alg: 'RS256', typ: 'JWT' },
    payload: {
      iss: clientEmail,
      scope: GOOGLE_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    algorithm: 'RSA-SHA256',
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const payload = await requestJson(fetchImpl, tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, 'Google OAuth token request');

  if (!payload.access_token) {
    throw new Error('Google OAuth token response did not include access_token');
  }
  return payload.access_token;
}

async function fetchAndroidTracks(fetchImpl, env) {
  requireEnvGroup(env, ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64', 'ANDROID_PACKAGE_NAME']);
  const encodedJson = requireEnv(env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64');
  const packageName = requireEnv(env, 'ANDROID_PACKAGE_NAME');
  const serviceAccount = parseJson(Buffer.from(encodedJson, 'base64').toString('utf8'), 'Google Play service account');
  const accessToken = await getGoogleAccessToken(fetchImpl, serviceAccount);
  const headers = { authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const edit = await requestJson(fetchImpl, `${baseUrl}/edits`, {
    method: 'POST',
    headers,
  }, 'Google Play edit insert');
  if (!edit.id) {
    throw new Error('Google Play edit insert response did not include id');
  }

  try {
    return await requestJson(fetchImpl, `${baseUrl}/edits/${encodeURIComponent(edit.id)}/tracks`, {
      method: 'GET',
      headers,
    }, 'Google Play tracks list');
  } finally {
    await fetchImpl(`${baseUrl}/edits/${encodeURIComponent(edit.id)}`, {
      method: 'DELETE',
      headers,
    }).catch(() => {});
  }
}

function createAppStoreConnectJwt(env) {
  const keyId = requireEnv(env, 'ASC_KEY_ID');
  const issuerId = requireEnv(env, 'ASC_ISSUER_ID');
  const privateKey = Buffer.from(requireEnv(env, 'ASC_API_KEY_P8_BASE64'), 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);

  return signJwt({
    header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
    payload: {
      iss: issuerId,
      iat: now,
      exp: now + 20 * 60,
      aud: ASC_AUDIENCE,
    },
    privateKey,
    algorithm: 'SHA256',
    dsaEncoding: 'ieee-p1363',
  });
}

async function fetchAllAppStoreConnectBuilds(fetchImpl, env) {
  requireEnvGroup(env, ['ASC_API_KEY_P8_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'IOS_APP_BUNDLE_ID']);
  const token = createAppStoreConnectJwt(env);
  const bundleId = requireEnv(env, 'IOS_APP_BUNDLE_ID');
  const headers = { authorization: `Bearer ${token}` };
  const appsUrl = new URL('/v1/apps', ASC_API_BASE_URL);
  appsUrl.searchParams.set('filter[bundleId]', bundleId);
  appsUrl.searchParams.set('limit', '1');

  const appsPayload = await requestJson(fetchImpl, appsUrl, { headers }, 'App Store Connect apps lookup');
  const appId = appsPayload?.data?.[0]?.id;
  if (!appId) {
    throw new Error(`App Store Connect app was not found for bundle id ${bundleId}`);
  }

  const builds = [];
  let nextUrl = new URL('/v1/builds', ASC_API_BASE_URL);
  nextUrl.searchParams.set('filter[app]', appId);
  nextUrl.searchParams.set('limit', '200');
  nextUrl.searchParams.set('sort', '-uploadedDate');

  while (nextUrl) {
    const payload = await requestJson(fetchImpl, nextUrl, { headers }, 'App Store Connect builds lookup');
    builds.push(...(payload.data ?? []));
    nextUrl = payload?.links?.next ? new URL(payload.links.next) : null;
  }

  return { data: builds };
}

export async function resolveStoreBuildNumber({
  platform,
  offset = 0,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!['android', 'ios'].includes(platform)) {
    throw new Error(`unknown platform "${platform}". Use android or ios.`);
  }

  if (platform === 'android') {
    const payload = env.STORE_ANDROID_TRACKS_JSON
      ? parseJson(env.STORE_ANDROID_TRACKS_JSON, 'STORE_ANDROID_TRACKS_JSON')
      : await fetchAndroidTracks(fetchImpl, env);
    return String(maxAndroidVersionCodeFromTracks(payload) + 1 + offset);
  }

  const payload = env.STORE_IOS_BUILDS_JSON
    ? parseJson(env.STORE_IOS_BUILDS_JSON, 'STORE_IOS_BUILDS_JSON')
    : await fetchAllAppStoreConnectBuilds(fetchImpl, env);
  return String(maxIosBuildNumberFromBuilds(payload, logger) + 1 + offset);
}

async function main() {
  try {
    const explicit = process.env.MOBILE_BUILD_NUMBER?.trim();
    if (explicit) {
      console.log(String(parsePositiveInteger(explicit, 'MOBILE_BUILD_NUMBER')));
      return;
    }
    const offset = parseNonNegativeInteger(process.env.MOBILE_BUILD_NUMBER_OFFSET, 'MOBILE_BUILD_NUMBER_OFFSET');
    const platform = process.env.MOBILE_PLATFORM?.trim() || 'android';
    console.log(await resolveStoreBuildNumber({ platform, offset }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
