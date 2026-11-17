import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioLoop } from '../src/core/audio.ts';
import { DeviceLevelController } from '../src/core/levels.ts';

function audio(options: { tail?: number; level?: number; click?: boolean; playbackEnd?: number; open?: number; now?: number } = {}) {
  const now = options.now ?? 3000;
  const fake = { nowMs: () => now, playing: undefined, lastPlaybackEndMs: options.playbackEnd ?? -Infinity,
    options: { playbackTailMs: 350 }, vad: { openSinceMs: options.open ?? 0, noiseFloorDb: -70 },
    samples: (from: number, to: number) => {
      const samples = new Int16Array(Math.floor((to - from) * 16));
      samples.fill(options.level ?? 160); // ~24 dB over floor
      if (options.tail) samples.fill(options.tail, samples.length - 6400);
      if (options.click) samples.fill(15000, 0, 320);
      return samples;
    } };
  return { fake, measure: (after = -Infinity) => AudioLoop.prototype.speechLevel.call(fake as never, 1900, after) };
}
test('median ignores phrase-tail dips; controller never raises in-band speech', async () => {
  for (const tail of [65, 80, 90]) {
    const a = audio({ tail });
    assert.ok(a.measure()!.overFloorDb > 23);
    const buttons: string[] = [];
    const controller = new DeviceLevelController({ run: async (_: string, args: { button: string }) => {
      buttons.push(args.button); return { ok: true, value: 0.5 };
    } } as never, { nowMs: a.fake.nowMs, speechLevel: a.measure } as never, { wait: async () => {} });
    await controller.tick();
    assert.deepEqual(buttons, []);
  }
});
test('sustained low speech measures low, including below old measurement cutoff', () => {
  assert.ok(audio({ level: 70 }).measure()!.overFloorDb < 20);
  assert.ok(audio({ level: 50 }).measure()!.overFloorDb < 15);
});
test('p95 rejects one-frame click and retains sustained loudness in latest 400 ms', () => {
  assert.ok(audio({ click: true }).measure()!.peakDb < -36);
  assert.ok(audio({ tail: 1500 }).measure()!.peakDb > -33);
});
test('requires full fresh window within segment, after playback tail and last press', () => {
  assert.equal(audio({ now: 1899 }).measure(), undefined);
  assert.equal(audio({ open: 1500 }).measure(), undefined);
  assert.equal(audio({ playbackEnd: 1000 }).measure(), undefined);
  assert.equal(audio().measure(1500), undefined);
  assert.ok(audio({ playbackEnd: 750 }).measure());
});

test('digital silence during VAD hangover cannot grant inaudible-start exception', () => {
  assert.equal(audio({ level: 0 }).measure(), undefined);
});
