#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const gradlePath = resolve(process.argv[2] ?? 'source/apps/mobile/android/app/build.gradle');
let text = readFileSync(gradlePath, 'utf8');

const releaseSigningBlock = [
  '        release {',
  '            def requiredSigningProps = [',
  "                'CI_UPLOAD_STORE_FILE',",
  "                'CI_UPLOAD_STORE_PASSWORD',",
  "                'CI_UPLOAD_KEY_ALIAS',",
  "                'CI_UPLOAD_KEY_PASSWORD'",
  '            ]',
  '            requiredSigningProps.each { propName ->',
  '                if (!project.hasProperty(propName) || project.property(propName).toString().trim().isEmpty()) {',
  '                    throw new GradleException("Missing Android release signing property: ${propName}")',
  '                }',
  '            }',
  "            storeFile file(project.property('CI_UPLOAD_STORE_FILE'))",
  "            storePassword project.property('CI_UPLOAD_STORE_PASSWORD')",
  "            keyAlias project.property('CI_UPLOAD_KEY_ALIAS')",
  "            keyPassword project.property('CI_UPLOAD_KEY_PASSWORD')",
  '        }',
].join('\n');

if (!text.includes('signingConfigs {')) {
  throw new Error(`Cannot find signingConfigs block in ${gradlePath}`);
}

if (!text.includes('CI_UPLOAD_STORE_FILE')) {
  const debugBlock = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;

  if (!text.includes(debugBlock)) {
    throw new Error(`Cannot find expected debug signing block in ${gradlePath}`);
  }

  text = text.replace(debugBlock, `${debugBlock}\n${releaseSigningBlock}`);
}

const next = text.replace(/signingConfig signingConfigs\.debug/g, 'signingConfig signingConfigs.release');
if (next === text && !text.includes('signingConfig signingConfigs.release')) {
  throw new Error(`Cannot replace release signingConfig in ${gradlePath}`);
}

writeFileSync(gradlePath, next);
console.log(`[android-signing] configured release signing in ${gradlePath}`);
