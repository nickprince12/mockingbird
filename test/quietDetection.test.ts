import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resegment } from '../src/core/resegment.ts';
import { captureDiagnosis } from '../src/core/captureDiagnosis.ts';
import { classifyHealth } from '../src/core/health.ts';
test('quiet speech scales with measured floor and excludes own playback plus tail', () => {
  for (const scale of [1, 4, 12]) {
    const pcm = Buffer.alloc(16000 * 2 * 6);
    for (let i = 0; i < pcm.length / 2; i++) {
      const sec = i / 16000;
      const amplitude = sec >= 1.5 && sec < 2.5 ? 1800 : sec >= 4 && sec < 5 ? 150 : 18;
      pcm.writeInt16LE(Math.round(Math.sin(i * .3) * amplitude * scale), i * 2);
    }
    const result = resegment(pcm, [{ startMs: 1500, endMs: 2500 }]);
    assert.equal(result.segments.length, 1);
    assert.ok(Math.abs(result.segments[0].startMs - 4000) < 40);
  }
});
test('renderer evidence without mic speech is infra; matching speech is not', () => {
  const report = { turns: [{ cueEndMs: 1000, cueEndWall: 11000, segments: [] as any[] }], timeline: { speech: [] as any[] }, appEvidence: { sessions: [{ events: [{ event: 'playback-observed', atWall: 12000 }] }] } };
  const checks = captureDiagnosis(report);
  assert.equal(classifyHealth({ checks: [...checks, { id: 'first-words', verdict: 'fail', detail: 'no first words heard' }] }).health, 'infra');
  report.turns[0].segments.push({ startMs: 1900, endMs: 3000 });
  assert.deepEqual(captureDiagnosis(report), []);
});
test('quiet lead-in is retained only after confirmed speech, never across playback', async () => {
  const { EnergyVad } = await import('../src/core/audio.ts');
  for (const playback of [false, true]) {
    const vad = new EnergyVad();
    for (let ms = 0; ms < 1000; ms += 20) vad.push(-70, ms, false);
    for (let ms = 1000; ms < 1200; ms += 20) vad.push(-62, ms, playback);
    assert.equal(vad.openSinceMs, undefined);
    for (let ms = 1200; ms < 1600; ms += 20) vad.push(-48, ms, false);
    assert.equal(vad.openSinceMs, playback ? 1200 : 1060);
  }
});

test('capture gaps retain product failures, heard first words, and exempt barge-in', () => {
  const gap = { id: 'played-not-heard', verdict: 'fail', detail: 'gap' };
  const noWords = { id: 'first-words', verdict: 'fail', detail: 'no first words heard' };
  assert.equal(classifyHealth({ checks: [gap, noWords, { id: 'ui-step', verdict: 'fail', detail: 'timer absent' }] }).health, 'product-fail');
  assert.equal(classifyHealth({ checks: [gap], startToFirstWordsMs: 500 }).health, 'product-fail');
  const report: any = { turns: [{ cueEndMs: 1000, cueEndWall: 11000, segments: [{ startMs: 2000, endMs: 2500 }] }], timeline: { playbacks: [] }, appEvidence: { sessions: [{ events: [{ event: 'playback-observed', atWall: 14500 }] }] } };
  assert.deepEqual(captureDiagnosis(report), []); // app clock 2 s ahead of heard endpoint
  report.turns[0].segments = [];
  report.timeline.playbacks = [{ startMs: 4000, endMs: 4500 }];
  assert.equal(captureDiagnosis(report)[0].verdict, 'unmeasured');
});
test('warmup transient does not hide quiet speech and floor can fall', async () => {
  const { EnergyVad } = await import('../src/core/audio.ts');
  const vad = new EnergyVad();
  for (let ms = 0; ms < 1000; ms += 20) vad.push(ms < 600 ? -20 : -70, ms, false);
  for (let ms = 1000; ms < 1800; ms += 20) vad.push(-48, ms, false);
  assert.ok(vad.openSinceMs !== undefined);
  for (let ms = 1800; ms < 7000; ms += 20) vad.push(-80, ms, false);
  assert.equal(vad.noiseFloorDb, -80);
});

test('absolute floor rejects sub -85 dB activity after near-silent warmup', async () => {
  const { EnergyVad } = await import('../src/core/audio.ts');
  const vad = new EnergyVad();
  for (let ms = 0; ms < 1000; ms += 20) vad.push(-99, ms, false);
  for (let ms = 1000; ms < 2000; ms += 20) vad.push(-86, ms, false);
  assert.equal(vad.openSinceMs, undefined);
});

test('454 synthetic PCM detects greeting onset and segment start at 17-18 dB over floor', () => {
  for (const margin of [17, 18]) {
    const pcm = Buffer.alloc(16000 * 2 * 4);
    for (let i = 0; i < pcm.length / 2; i++) {
      const speech = i >= 16000 && i < 32000;
      const amplitude = 18 * (speech ? 10 ** (margin / 20) : 1);
      pcm.writeInt16LE(Math.round(Math.sin(i * .3) * amplitude), i * 2);
    }
    const { segments } = resegment(pcm, []);
    assert.equal(segments.length, 1);
    // The first segment is the greeting onset used by the live loop.
    assert.ok(Math.abs(segments[0].startMs - 1000) <= 40, `${margin}: ${segments[0].startMs}`);
    assert.ok(segments[0].endMs >= 2000);
  }
});
