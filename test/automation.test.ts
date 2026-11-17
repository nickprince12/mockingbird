import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationFailure, UI_AUTOMATION_OFF, PhoneDriver } from '../src/core/driver.ts';
import { automationPreflight } from '../src/matrix.ts';

test('automation signature is specific, including split xcodebuild output', () => {
  assert.equal(automationFailure('xcodebuild exited 65'), false);
  assert.equal(automationFailure('Timed out while enabling automation mode'), true);
  const dir = mkdtempSync(join(tmpdir(), 'automation-'));
  try {
    // Exercise the actual streaming log handler without constructing a device.
    const driver = Object.create(PhoneDriver.prototype) as any;
    Object.assign(driver, { automationLog: '', automationOff: false, logTails: new Map(), secrets: [], options: { logFile: join(dir, 'xcodebuild.log') } });
    driver.writeLog('Timed out while enabling auto');
    driver.writeLog('mation mode');
    assert.equal(driver.automationOff, true);
  } finally { rmSync(dir, { recursive: true }); }
});

test('failed preflight stops the driver and writes the actionable failure to both artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-'));
  let starts = 0, stops = 0;
  try {
    const ok = await automationPreflight({ start: async () => { starts++; throw new Error(UI_AUTOMATION_OFF); }, stop: async () => { stops++; } }, dir);
    assert.equal(ok, false);
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    for (const file of ['summary.md', 'run.log']) assert.ok(readFileSync(join(dir, file), 'utf8').includes(UI_AUTOMATION_OFF));
  } finally { rmSync(dir, { recursive: true }); }
});

test('successful preflight starts and stops once', async () => {
  const calls: string[] = [];
  assert.equal(await automationPreflight({ start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); } }, '/unused'), true);
  assert.deepEqual(calls, ['start', 'stop']);
});
