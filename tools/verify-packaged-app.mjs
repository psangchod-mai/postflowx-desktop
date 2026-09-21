#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { listPackage, extractFile } from '@electron/asar';
import {
  REQUIRED_NATIVE_ENTRIES,
  assessAsarInventory,
  classifyMacSignature,
  summarizePackagedApp,
} from './packaged-app-verifier-core.mjs';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const requestedPath = args.find(arg => !arg.startsWith('--'));
const appPath = resolve(requestedPath || 'dist/mac-arm64/PostFlowX.app');
const contents = join(appPath, 'Contents');
const resources = join(contents, 'Resources');
const asarPath = join(resources, 'app.asar');
const plistPath = join(contents, 'Info.plist');
const executablePath = join(contents, 'MacOS', 'PostFlowX');

function command(file, commandArgs, options = {}) {
  const result = spawnSync(file, commandArgs, { encoding: 'utf8', ...options });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    ok: result.status === 0 && !result.error,
    output,
    error: result.error?.message || (result.status === 0 ? '' : `exit ${result.status}`),
  };
}

function plistValue(key) {
  const result = command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath]);
  return result.ok ? result.output : '';
}

function nativeStatus(relativePath) {
  const fullPath = join(resources, 'app.asar.unpacked', relativePath);
  if (!existsSync(fullPath)) return { path: relativePath, ok: false, reason: 'missing' };
  try {
    accessSync(fullPath, constants.X_OK);
    return { path: relativePath, ok: statSync(fullPath).isFile(), reason: '' };
  } catch {
    return { path: relativePath, ok: false, reason: 'not executable' };
  }
}

if (!existsSync(appPath) || !existsSync(asarPath) || !existsSync(plistPath)) {
  const failure = { localReady: false, distributionReady: false, appPath, error: 'PostFlowX.app is incomplete or missing app.asar/Info.plist.' };
  console.error(jsonOnly ? JSON.stringify(failure, null, 2) : `FAIL  ${failure.error}\n      ${appPath}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const inventory = assessAsarInventory(listPackage(asarPath));
const nativeChecks = REQUIRED_NATIVE_ENTRIES.map(nativeStatus);
const native = {
  ok: nativeChecks.every(item => item.ok),
  checks: nativeChecks,
};

let authConfigValid = false;
try {
  const config = JSON.parse(readFileSync(join(resources, 'authConfig.json'), 'utf8'));
  authConfigValid = Boolean(config && typeof config === 'object');
} catch {}

let healthModelWired = false;
try {
  const prepSource = extractFile(asarPath, 'dist/desktop/scripts/prep_mark.js').toString('utf8');
  const healthSource = extractFile(asarPath, 'dist/desktop/scripts/core/pullPrepHealth.js').toString('utf8');
  healthModelWired = prepSource.includes("from './core/pullPrepHealth.js'")
    && prepSource.includes('derivePullPrepHealth(')
    && prepSource.includes('localizePullPrepHealth(')
    && prepSource.includes("window.addEventListener('pfx:languagechange', _pmUpdateProWorkspace)")
    && healthSource.includes('export function derivePullPrepHealth')
    && healthSource.includes('export function localizePullPrepHealth')
    && healthSource.includes("title: 'พร้อมเริ่มงาน'");
} catch {}

const metadata = {
  ok: plistValue('CFBundleIdentifier') === packageJson.build.appId
    && plistValue('CFBundleShortVersionString') === packageJson.version
    && authConfigValid
    && healthModelWired,
  bundleId: plistValue('CFBundleIdentifier'),
  version: plistValue('CFBundleShortVersionString'),
  expectedBundleId: packageJson.build.appId,
  expectedVersion: packageJson.version,
  authConfigValid,
  healthModelWired,
};

const codesignVerify = command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
const codesignDetail = command('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
const spctl = command('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'execute', appPath]);
const architecture = command('/usr/bin/file', [executablePath]);
const signature = classifyMacSignature(codesignDetail.output, spctl.ok);
const summary = summarizePackagedApp({
  inventory,
  native,
  metadata,
  codesign: { ok: codesignVerify.ok, detail: codesignVerify.output },
  signature,
});

const report = {
  ...summary,
  appPath,
  architecture: architecture.output,
  gatekeeperDetail: spctl.output,
};

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = value => value ? 'PASS' : 'FAIL';
  console.log(`${mark(inventory.ok)}  ASAR inventory (${inventory.totalEntries} entries)`);
  if (inventory.missing.length) console.log(`      Missing: ${inventory.missing.join(', ')}`);
  console.log(`${mark(native.ok)}  Native AVFoundation/media engines executable`);
  console.log(`${mark(metadata.ok)}  Bundle metadata, auth config, and Project Health wiring`);
  console.log(`${mark(codesignVerify.ok && signature.hardenedRuntime)}  Code signature (${signature.mode}, hardened runtime)`);
  console.log(`${signature.distributionReady ? 'PASS' : 'INFO'}  Gatekeeper distribution (${signature.distributionReady ? 'ready' : 'not Developer ID/notarized'})`);
  console.log(`      ${architecture.output}`);
  console.log(`\n${report.localReady ? 'LOCAL APP READY' : 'LOCAL APP NOT READY'}\n${appPath}`);
}

process.exit(report.localReady ? 0 : 1);
