#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const publicVersionPath = path.join(projectRoot, 'public', 'version.json');
const constantsVersionPath = path.join(projectRoot, 'constants', 'version.ts');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const buildTimestamp = new Date().toISOString();
const buildId = process.env.BUILD_ID || buildTimestamp;
const versionPayload = {
  appVersion: packageJson.version,
  buildId,
  generatedAt: buildTimestamp,
};

fs.writeFileSync(publicVersionPath, `${JSON.stringify(versionPayload, null, 2)}\n`, 'utf8');

const versionModule = `export const VERSION_METADATA = ${JSON.stringify(versionPayload, null, 2)} as const;\n`;
fs.writeFileSync(constantsVersionPath, versionModule, 'utf8');

console.log(`Generated version metadata: ${versionPayload.appVersion} (${versionPayload.buildId})`);
