import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../src/core/assertions.ts';
import { quietTarget } from '../src/core/runOptions.ts';
import { DeviceLevelController } from '../src/core/levels.ts';
import { readProfile, saveProfile, type AudioProfile } from '../src/core/profile.ts';

function rig(initial: number, options: { quietTarget?: boolean; step?: number; frozen?: boolean; peak?: number; max?: number; previous?: AudioProfile['callLevel'] } = {}) {
  let db = initial, settled: AudioProfile['callLevel'];
  const buttons: string[] = [];
  const driver = { run: async (_: string, args: { button: string }) => {
    buttons.push(args.button);
    if (!options.frozen) db += (args.button === 'volumeUp' ? 1 : -1) * (options.step ?? 3);
    return { ok: true, value: 0.5 };
  } };
  const audio = { speechLevel: () => ({ db: db - 70, overFloorDb: db, peakDb: options.peak ?? db - 65 }), nowMs: () => 0 };
  const controller = new DeviceLevelController(driver as never, audio as never, {
    quietTarget: options.quietTarget, previous: options.previous, maxPresses: options.max, settleMs: 300, wait: async () => {}, onSettled: value => { settled = value; },
  });
  return { controller, buttons, get settled() { return settled; } };
}
async function finish(r: ReturnType<typeof rig>) { for (let i = 0; i < 40 && r.controller.result.stoppedBecause === 'run ended'; i++) await r.controller.tick(); }
test('quiet route rises; loud route descends to quiet anchor before rising', async () => {
  const quiet = rig(17); await finish(quiet); assert.deepEqual(quiet.buttons, ['volumeUp']);
  const loud = rig(38); await finish(loud);
  assert.deepEqual(loud.buttons, Array(6).fill('volumeDown'));
  assert.equal(loud.settled?.levelOverFloorDb, 20);
  const overshoot = rig(37); await finish(overshoot);
  assert.equal(overshoot.buttons.at(-1), 'volumeDown');
  assert.equal(overshoot.settled?.levelOverFloorDb, 22);
});
test('absolute peak ceiling descends only while a safe step remains', async () => {
  const r = rig(25, { peak: -30, max: 4 }); await finish(r);
  assert.deepEqual(r.buttons, Array(1).fill('volumeDown'));
  assert.match(r.controller.result.stoppedBecause, /settled/);
  assert.equal(r.settled?.levelOverFloorDb, 22);
});
test('two unchanged measurements stop both directions even when media reading is constant', async () => {
  for (const db of [17, 40]) {
    const r = rig(db, { frozen: true }); await finish(r);
    assert.equal(r.buttons.length, 2);
    assert.match(r.controller.result.stoppedBecause, /two presses/);
    assert.equal(r.settled, undefined);
  }
});
test('settled calibration survives profile roundtrip and repeated runs do not ratchet', async () => {
  const old = process.env.MOCKINGBIRD_HOME;
  process.env.MOCKINGBIRD_HOME = mkdtempSync(join(tmpdir(), 'rig458-'));
  try {
    const first = rig(37); await finish(first);
    saveProfile('test', { deviceVolume: 0.5, callLevel: first.settled });
    const profile = readProfile('test')!;
    assert.deepEqual(profile.callLevel, first.settled);
    const next = rig(profile.callLevel!.levelOverFloorDb, { previous: profile.callLevel }); await finish(next);
    assert.deepEqual(next.buttons, []);
    assert.equal(next.settled?.netPresses, first.settled?.netPresses);
    assert.equal(readProfile('test')?.deviceVolume, 0.5);
  } finally { rmSync(process.env.MOCKINGBIRD_HOME!, { recursive: true }); if (old === undefined) delete process.env.MOCKINGBIRD_HOME; else process.env.MOCKINGBIRD_HOME = old; }
});

function scripted(levels: Array<number | undefined>, active = true, onSettled?: () => void) {
  const buttons: string[] = [], logs: string[] = [];
  let index = 0;
  const controller = new DeviceLevelController({ run: async (_: string, args: { button: string }) => {
    buttons.push(args.button); return { ok: true, value: 0.5 };
  } } as never, { nowMs: () => index * 2000, speechActive: () => active,
    speechLevel: () => { const db = levels[Math.min(index++, levels.length - 1)];
      return db === undefined ? undefined : { db: db - 70, overFloorDb: db, peakDb: -45 }; }
  } as never, { maxPresses: 4, settleMs: 600, wait: async () => {}, onSettled, log: line => logs.push(line) });
  return { controller, buttons, logs };
}
test('unmeasurable speech only undoes a prior down once', async () => {
  for (const r of [scripted([undefined]), scripted([35, undefined])]) {
    await finish(r as never);
    assert.deepEqual(r.buttons, r.buttons.length ? ['volumeDown', 'volumeUp'] : []);
  }
});
test('malformed profiles in settlement are caught and logged', async () => {
  const old = process.env.MOCKINGBIRD_HOME;
  process.env.MOCKINGBIRD_HOME = mkdtempSync(join(tmpdir(), 'rig458b-'));
  try {
    writeFileSync(join(process.env.MOCKINGBIRD_HOME, 'profiles.json'), '{broken');
    const r = scripted([23], true, () => saveProfile('test', {}));
    await finish(r as never);
    assert.ok(r.logs.some(line => line.includes('profile save failed')));
    assert.match(r.controller.result.stoppedBecause, /settled/);
  } finally { rmSync(process.env.MOCKINGBIRD_HOME!, { recursive: true }); if (old === undefined) delete process.env.MOCKINGBIRD_HOME; else process.env.MOCKINGBIRD_HOME = old; }
});

test('ceiling never presses down at or below band floor', async () => {
  for (const db of [17, 20, 22]) {
    const r = rig(db, { peak: -30 }); await finish(r);
    assert.ok(!r.buttons.includes('volumeDown'));
  }
});
test('press cap bounds a large slow-changing response', async () => {
  const r = rig(50, { max: 2 }); await finish(r);
  assert.equal(r.buttons.length, 2); assert.match(r.controller.result.stoppedBecause, /press cap/);
});

test('absolute up ceiling applies below the relative floor, at every press', async () => {
  for (const peak of [-35.9, -33, -30]) {
    const r = rig(17, { peak }); await finish(r);
    assert.deepEqual(r.buttons, []);
  }
  const allowed = rig(17, { peak: -36 }); await finish(allowed);
  assert.deepEqual(allowed.buttons, ['volumeUp']);
});
test('net up cap is two unless first sustained level is measurably inaudible', async () => {
  const r = rig(15, { step: 1.6, peak: -45 }); await finish(r);
  assert.deepEqual(r.buttons, ['volumeUp', 'volumeUp']);
  assert.match(r.controller.result.stoppedBecause, /net up cap/);
  const inaudible = rig(13, { step: 1.6, peak: -45 }); await finish(inaudible);
  assert.ok(inaudible.buttons.length > 2);
  assert.match(inaudible.controller.result.stoppedBecause, /settled/);
});

// Recorded 458b phone run, 2026-11-14T02:14:22.289Z, cascade-sonnet.
// These are historical 500 ms measurements, NOT synthesized sustained levels.
// Replaying them directly is a conservative ceiling regression, not a claim
// that this history can reconstruct PCM/VAD boundaries.
test('458b recorded history: downs or no presses, never ups', async () => {
  const history = [[69380, 18.8, -31.47549593663139], [70880, 24.2, -28.171820100345343], [71180, 23.7, -28.171820100345343], [71480, 22.1, -29.91276352060116], [71780, 18.9, -31.358273471849394], [85380, 23.7, -30.511901115680963], [85680, 23.2, -30.996117009124827], [85980, 25.3, -28.38098521892791], [86280, 23.6, -29.154298777366346], [86880, 17.4, -35.719134506692306], [88380, 22.5, -30.250635188908245], [88680, 23.6, -29.684015541900095], [88980, 23.1, -29.684015541900095], [89580, 15.9, -35.19324244593621], [106480, 25.7, -27.20186852176477], [107080, 25, -29.838880043742098], [107380, 26.3, -28.756041631631135], [107680, 26.4, -28.42298395776011], [107980, 26.4, -28.42298395776011], [108280, 24.6, -30.47240489113846], [108580, 22.1, -32.649812115926366], [118880, 26.7, -28.579299755859914], [119180, 26.3, -29.003197072036464], [119480, 23.9, -31.493246590335346], [119780, 23.8, -30.665073222172047], [120080, 24.9, -30.414891366212416], [120380, 23.4, -32.0228463141418], [120680, 17.6, -36.193609020494314], [121880, 21.7, -32.88439666393532], [122180, 19.9, -33.65969858543019], [123680, 20.5, -32.81967005339119], [123980, 26.1, -26.703279219462246], [124280, 25.5, -26.703279219462246], [124580, 20.2, -32.081441003298046], [124880, 19.4, -31.31097207639565], [126080, 16, -31.512146417378023], [139380, 26.6, -29.152583836286144], [139680, 25.7, -29.310078411212366], [139980, 25, -30.3173684343397], [140280, 24.8, -30.3173684343397], [141180, 21.3, -30.65475924809377], [141480, 26.1, -28.384939829943363], [141780, 25.8, -28.384939829943363], [142380, 25.4, -29.086910981554965], [142680, 25, -29.376914573185317], [142980, 24.8, -29.376914573185317], [143280, 23.2, -30.251833271557018], [143580, 19.1, -33.995806708505036], [144780, 23.1, -28.643152641274938], [145080, 22.6, -28.643152641274938], [145380, 19.2, -31.8401592865473], [148080, 15.4, -29.267797539719894], [160180, 25.5, -29.431531999413707], [160480, 24, -30.339191356687863], [161080, 20.8, -29.743011612102745], [161380, 27.2, -28.40989388550446], [161680, 27.2, -28.40989388550446], [161980, 25.5, -29.45206002427147], [162280, 25.2, -30.333186510525557], [162580, 25.4, -28.487665790210762], [162880, 21.3, -31.811437857525313]];
  let index = 0;
  const buttons: string[] = [];
  const controller = new DeviceLevelController({ run: async (_: string, args: { button: string }) => {
    buttons.push(args.button); return { ok: true, value: 0.5 };
  } } as never, { nowMs: () => history[Math.min(index, history.length - 1)][0],
    speechLevel: () => { const [, overFloorDb, peakDb] = history[Math.min(index++, history.length - 1)];
      return { db: overFloorDb - 70, overFloorDb, peakDb }; }
  } as never, { wait: async () => {} });
  for (const row of history) await controller.tick();
  assert.ok(buttons.every(button => button === 'volumeDown'));
  // Also exercise every recorded row as a decision, rather than allowing an
  // early safety stop to hide a later dip. An in-band loud row must step down.
  let downs = 0;
  for (const [atMs, overFloorDb, recordedPeak] of history) {
    const peakDb = Math.max(recordedPeak, ...history.filter(row => row[0] <= atMs && row[0] >= atMs - 1900).map(row => row[2]));
    const decisions: string[] = [];
    const single = new DeviceLevelController({ run: async (_: string, args: { button: string }) => {
      decisions.push(args.button); return { ok: true, value: 0.5 };
    } } as never, { nowMs: () => 0, speechLevel: () => ({ db: overFloorDb - 70, overFloorDb, peakDb }) } as never,
    { wait: async () => {} });
    await single.tick();
    assert.ok(decisions.every(button => button === 'volumeDown'));
    downs += decisions.length;
  }
  assert.ok(downs > 0);

});

test('quiet target flags, environment and adapter device default', () => {
  assert.equal(quietTarget(true, false, [], ''), true);
  assert.equal(quietTarget(true, true, [], ''), false);
  assert.equal(quietTarget(false, false, [], ''), false);
  assert.equal(quietTarget(false, false, [], '1'), true);
  assert.equal(quietTarget(false, true, ['--quiet-target'], ''), true);
  assert.equal(quietTarget(true, false, ['--quiet-target', '--no-quiet-target'], '1'), false);
});
// Recorded operating range from brief 467; simulate a measured 3 dB button
// response, not PCM replay or physical phone acceptance.
test('467 loud histories descend into quiet band without ups or crossing 12 dB', async () => {
  for (const initial of [27, 29, 32, 35]) for (const peak of [-29, -30, -32]) {
    const r = rig(initial, { quietTarget: true, peak }); await finish(r);
    assert.ok(r.buttons.length > 0);
    assert.ok(r.buttons.every(button => button === 'volumeDown'));
    assert.ok(r.settled!.levelOverFloorDb >= 17 && r.settled!.levelOverFloorDb <= 24);
    assert.ok(r.controller.history.every(row => row.levelOverFloorDb >= 12));
  }
});
test('quiet target absolute ceilings and measured-step guard', async () => {
  for (const db of [13, 16, 17, 20, 21]) {
    const r = rig(db, { quietTarget: true, peak: -35 }); await finish(r);
    assert.deepEqual(r.buttons, []);
  }
  const blocked = rig(12, { quietTarget: true, peak: -37.9 }); await finish(blocked);
  assert.deepEqual(blocked.buttons, []);
  const up = rig(12, { quietTarget: true, peak: -38 }); await finish(up);
  assert.ok(up.buttons.includes('volumeUp'));
});

test('reply-level-margin accepts quiet target band and still warns under 10 dB', () => {
  for (const margin of [9.9, 10, 12, 14, 22]) {
    const turn = { index: 1, kind: 'say' as const, text: 'Next', cueEndMs: 0, replyStartMs: 1, extraSegments: 0, replyMarginDb: margin };
    const check = evaluate({ turns: [turn], micAvailable: true, spokenLines: [], uiErrors: [] }).find(c => c.id === 'reply-level-margin');
    assert.equal(check?.verdict, margin < 10 ? 'warn' : 'pass');
  }
});

test('non-uniform 3, 4, 6 dB steps preserve detector headroom and settlement is permanent', async () => {
  for (const initial of [27, 29, 32, 35, 40]) {
    let db = initial, n = 0;
    const landed: number[] = [];
    const c = new DeviceLevelController({ run: async (_: string, a: { button: string }) => {
      db += (a.button === 'volumeDown' ? -1 : 1) * [3, 4, 6][n++ % 3];
      landed.push(db); return { ok: true, value: .5 };
    } } as never, { nowMs: () => 0, speechLevel: () => ({ overFloorDb: db, peakDb: -45 }) } as never,
    { quietTarget: true, settleMs: 300, wait: async () => {} });
    await finish({ controller: c } as never);
    assert.ok(landed.length > 0);
    assert.ok(landed.every(x => x >= 12), JSON.stringify(landed));
    const presses = n; db = 8; await c.tick(); assert.equal(n, presses);
  }
});
test('a down that loses measurable speech is undone on the third active tick, never in silence', async () => {
  for (const active of [false, true]) {
    const r = scripted([35, undefined], active);
    await r.controller.tick();
    await r.controller.tick(); await r.controller.tick();
    assert.deepEqual(r.buttons, ['volumeDown']);
    await r.controller.tick();
    assert.deepEqual(r.buttons, active ? ['volumeDown', 'volumeUp'] : ['volumeDown']);
    await finish(r as never);
    assert.equal(r.buttons.length, active ? 2 : 1);
  }
});

test('unexpected sub-12 dB landing recovers one down when measurement disappears', async () => {
  let db = 27, presses = 0, clock = 0;
  const buttons: string[] = [];
  const c = new DeviceLevelController({ run: async (_: string, a: { button: string }) => {
    buttons.push(a.button);
    db += a.button === 'volumeUp' ? 18 : -[3, 4, 18][presses++];
    return { ok: true, value: .5 };
  } } as never, { nowMs: () => clock, speechActive: () => true,
    speechLevel: () => { clock += 2000; return db < 12 ? undefined : { overFloorDb: db, peakDb: -45 }; }
  } as never, { quietTarget: true, wait: async () => {} });
  // A normal 3/4 dB sequence is guarded before a third down; force an
  // unexpectedly large third step to exercise loss-of-measurement recovery.
  db = 35;
  await finish({ controller: c } as never);
  assert.equal(buttons.at(-1), 'volumeUp');
  assert.ok(db >= 12);
  assert.match(c.result.stoppedBecause, /recovered/);
});
