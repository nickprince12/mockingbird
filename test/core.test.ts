import { test } from "node:test";
import assert from "node:assert/strict";
import { EnergyVad, defaultVad } from "../src/core/audio.ts";
import { evaluate } from "../src/core/assertions.ts";

test("VAD opens on speech after silence and closes after the hangover", () => {
  const vad = new EnergyVad(defaultVad);
  let ms = 0;
  for (let i = 0; i < 50; i++) vad.push(-70, (ms += 20), false);   // 1 s of quiet
  for (let i = 0; i < 50; i++) vad.push(-20, (ms += 20), false);   // 1 s of speech
  for (let i = 0; i < 60; i++) vad.push(-70, (ms += 20), false);   // 1.2 s of quiet
  assert.equal(vad.segments.length, 1);
  assert.ok(Math.abs(vad.segments[0].startMs - 1020) <= 20, `onset ${vad.segments[0].startMs}`);
});

test("speech during the speaker's own playback never opens a segment", () => {
  const vad = new EnergyVad(defaultVad);
  let ms = 0;
  for (let i = 0; i < 50; i++) vad.push(-70, (ms += 20), false);
  for (let i = 0; i < 50; i++) vad.push(-20, (ms += 20), true);
  for (let i = 0; i < 60; i++) vad.push(-70, (ms += 20), false);
  assert.equal(vad.segments.length, 0);
});

test("a check without evidence is unmeasured, never a pass", () => {
  const checks = evaluate({ turns: [], micAvailable: false, spokenLines: ["hello"], uiErrors: [] });
  const first = checks.find((c) => c.id === "first-words");
  assert.equal(first?.verdict, "unmeasured");
  assert.ok(!checks.some((c) => c.verdict === "pass"));
});

test("a repeated line in the app's speech fails", () => {
  const line = "Preheat the oven to four hundred degrees now.";
  const checks = evaluate({ turns: [], micAvailable: false, spokenLines: [], uiErrors: [],
    backend: { sessions: ["s"], assistant: [{ text: line, atIso: "2026-01-01T00:00:00Z", sessionId: "s" }, { text: line, atIso: "2026-01-01T00:00:05Z", sessionId: "s" }], user: [] } });
  assert.equal(checks.find((c) => c.id === "no-repeated-line")?.verdict, "fail");
});

import { judgeCalibration, toneOnsetMs, sampleRate } from "../src/core/audio.ts";

test("digital silence at start-up never makes room tone look like speech", () => {
  const vad = new EnergyVad(defaultVad);
  let ms = 0;
  for (let i = 0; i < 75; i++) vad.push(-120, (ms += 20), false); // device starting: zeros
  for (let i = 0; i < 150; i++) vad.push(-62 + (i % 3), (ms += 20), false); // ordinary room tone
  assert.equal(vad.segments.length + (vad.speaking ? 1 : 0), 0);
});

test("tone onset is found by frequency", () => {
  const samples = new Int16Array(sampleRate); // 1 s
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round((Math.random() - 0.5) * 300);
  const start = Math.round(sampleRate * 0.42);
  for (let i = start; i < start + sampleRate * 0.15; i++) samples[i] += Math.round(Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 8000);
  const onset = toneOnsetMs(samples, 1000)!;
  assert.ok(Math.abs(onset - 420) <= 10, `onset ${onset}`);
});

test("a negative or unstable calibration is invalid", () => {
  assert.equal(judgeCalibration([-1400, -1380, -1390], 3).valid, false);
  assert.equal(judgeCalibration([90, 400, 95], 3).valid, false);
  assert.equal(judgeCalibration([90], 3).valid, false);
  const ok = judgeCalibration([92, 88, 101], 3);
  assert.equal(ok.valid, true); assert.equal(ok.offsetMs, 92);
});

test("latency checks never pass on an invalid calibration", () => {
  const checks = evaluate({ turns: [], micAvailable: true, startToFirstWordsMs: 3000, spokenLines: [], uiErrors: [],
    calibration: { valid: false, reason: "negative offset" } });
  assert.equal(checks.find((c) => c.id === "first-words")?.verdict, "unmeasured");
  assert.equal(checks.find((c) => c.id === "audio-calibration")?.verdict, "fail");
});

import { isNonSpeech } from "../src/run.ts";
test("whisper's non-speech markers are not replies", () => {
  for (const t of ["(loud thud)", "[typing]", "[BLANK_AUDIO]", " (keyboard clicking) ", "", "*music*", "you", " You.", "Thank you."]) assert.equal(isNonSpeech(t), true, t);
  for (const t of ["Okay, let's start.", "- Done.", "(laughs) Okay"]) assert.equal(isNonSpeech(t), false, t);
});

test("backend checks are n/a, never fail, when the backend's records are unavailable by design", () => {
  const turn = { index: 3, kind: "say" as const, text: "Done.", expect: "advance" as const, cueEndMs: 1000, cueEndWall: 1_000_000, extraSegments: 0 };
  const checks = evaluate({ turns: [turn], micAvailable: false, spokenLines: ["Done."], uiErrors: [], voiceStartWall: 999_000,
    backend: { sessions: [], assistant: [], user: [], firstOutputWalls: [], advanceEvents: [], unavailable: "hosted backend" } });
  for (const id of ["first-words:app-trace", "no-repeated-line", "advances#3"]) assert.equal(checks.find((c) => c.id === id)?.verdict, "n/a", id);
  assert.ok(!checks.some((c) => c.source === "backend" && c.verdict === "fail"));
});

test("a reachable but silent backend still fails the app-trace check", () => {
  const checks = evaluate({ turns: [], micAvailable: false, spokenLines: [], uiErrors: [], voiceStartWall: 1,
    backend: { sessions: [], assistant: [], user: [], firstOutputWalls: [] } });
  assert.equal(checks.find((c) => c.id === "first-words:app-trace")?.verdict, "fail");
});

import { compareReports, comparisonMarkdown, summarizeRun, type RunReport } from "../src/compare.ts";
import { passthrough } from "../src/matrix.ts";
import { applyArm, type Scenario } from "../src/run.ts";

const fakeRun = (arm: string, latencies: Array<number | undefined>, extra: Partial<RunReport> = {}): RunReport => ({
  verdict: "FAIL", scenario: "s", arm: { id: arm }, startedAt: "t", startToFirstWordsMs: 6000, spendUsd: 0.12,
  turns: [{ index: 5, kind: "greeting", cueEndMs: 0, replyStartMs: 6000 },
    ...latencies.map((ms, i) => ({ index: 6 + i, kind: "say", text: `line ${i}`, cueEndMs: 10000 * (i + 1), replyStartMs: ms === undefined ? undefined : 10000 * (i + 1) + ms, extraSegments: i === 0 ? 1 : 0 }))],
  checks: [{ id: "reply-words#6", verdict: "fail", source: "acoustic", detail: "did not match" }, { id: "forbidden-words", verdict: "pass", source: "acoustic", detail: "" }],
  ...extra,
});

test("a run summary counts stalls, unanswered lines and rule checks", () => {
  const s = summarizeRun(fakeRun("a", [1000, 3000, 12000, undefined]));
  assert.equal(s.asked, 4); assert.equal(s.replies, 3);
  assert.deepEqual(s.unanswered, ["line 3"]);
  assert.equal(s.usefulStalls10s, 2); // one 12 s reply + one unanswered
  // No segment transcripts in this report: useful falls back to first audio, and says so.
  assert.equal(s.usefulMeasured, false);
  assert.equal(s.useful.p50, 3000); assert.equal(s.useful.max, 12000); assert.equal(s.useful.maxAfter, "line 2");
  assert.equal(s.firstAudio.max, 12000);
  assert.equal(s.unpromptedSegments, 1);
  assert.deepEqual([s.rules.pass, s.rules.fail], [1, 1]);
  assert.equal(s.firstWordsMs, 6000);
});

test("the comparison lines up the same script line across arms", () => {
  const c = compareReports([{ report: fakeRun("live", [1000, 2000]) }, { report: fakeRun("cascade", [4000, undefined]) }]);
  const row = c.perLine.find((l) => l.index === 7)!;
  assert.equal(row.byArm.live, "2.0 s"); assert.equal(row.byArm.cascade, "NO REPLY");
  const md = comparisonMarkdown(c);
  assert.match(md, /\| live \| cascade \|/); assert.match(md, /NO REPLY/);
});

test("an arm patches the scenario and merges the launch environment", () => {
  const base = { id: "s", description: "", app: "x", launchEnv: { A: "1" }, steps: [{ say: "hi" }] } as Scenario;
  const out = applyArm(base, { id: "b", scenario: { engine: "cascade", launchEnv: { B: "2" } } });
  assert.deepEqual(out.launchEnv, { A: "1", B: "2" });
  assert.equal(out.engine, "cascade"); assert.equal(out.arm, "b"); assert.equal(out.steps.length, 1);
});

test("the matrix keeps its own options and passes the rest to each run", () => {
  assert.deepEqual(passthrough(["--arms", "x", "--device", "d", "--scenario", "a,b", "--usb", "--only", "live", "--reports", "r", "--budget", "2"]), ["--device", "d", "--usb", "--budget", "2"]);
});

test("a per-line forbidden pattern fails only that line", () => {
  const turn = { index: 4, kind: "say" as const, text: "I want green beans for four.", cueEndMs: 0, replyStartMs: 1, extraSegments: 0, replyTranscript: "Great. Preheat the oven to 425." };
  const checks = evaluate({ turns: [turn], micAvailable: true, spokenLines: [], uiErrors: [], forbidWords: { 4: "preheat|heat the oven" }, expectWords: { 4: "sound right" } });
  assert.equal(checks.find((c) => c.id === "reply-not-words#4")?.verdict, "fail");
  assert.equal(checks.find((c) => c.id === "reply-words#4")?.verdict, "fail");
});

import { isFillerOnly } from "../src/core/filler.ts";

test("filler is a whole segment of filler words, loosely spelled", () => {
  for (const t of ["Checking.", "One moment.", "Let me check.", "One sec", "Okay.", "Mm-hm.", "MMA", "Got it.", "God it, let me check.", "Sure.", "Alright", "Okay, one moment."]) assert.ok(isFillerOnly(t), t);
  for (const t of ["Okay, set the thermostat to 68.", "Yes.", "Twenty minutes left.", "Right, the hallway.", "", "[BLANK_AUDIO]"]) assert.ok(!isFillerOnly(t), t);
});

test("the headline is time to the first non-filler segment; filler-only replies are stalls", () => {
  const turns = [
    { index: 6, kind: "say" as const, text: "What's next?", cueEndMs: 0, replyStartMs: 800, replyEndMs: 9000, extraSegments: 0,
      segments: [{ startMs: 800, endMs: 1500, transcript: "Checking.", filler: true }, { startMs: 7000, endMs: 9000, transcript: "Toss everything in a bowl." }],
      usefulStartMs: 7000, fillerSegments: 1 },
    { index: 7, kind: "say" as const, text: "Done.", cueEndMs: 20000, replyStartMs: 21000, replyEndMs: 22000, extraSegments: 0,
      segments: [{ startMs: 21000, endMs: 22000, transcript: "One moment.", filler: true }], fillerSegments: 1 },
    { index: 8, kind: "say" as const, text: "How long?", cueEndMs: 30000, replyStartMs: 31000, replyEndMs: 33000, extraSegments: 0,
      segments: [{ startMs: 31000, endMs: 33000, transcript: "Twelve minutes left." }], usefulStartMs: 31000, fillerSegments: 0 },
  ];
  const checks = evaluate({ turns, micAvailable: true, spokenLines: [], uiErrors: [] });
  const get = (id: string) => checks.find((c) => c.id === id)!;
  assert.equal(get("useful-reply-latency").verdict, "fail"); // the filler-only "Done."
  assert.match(get("useful-reply-latency").detail, /7\.0 s after "What's next\?"/);
  assert.equal(get("useful-reply-stalls").verdict, "fail");
  assert.equal(get("filler-segments").verdict, "warn");
  assert.equal(get("first-audio-latency").verdict, "pass"); // filler hides the wait from first audio

  const report: RunReport = { verdict: "FAIL", scenario: "s", arm: { id: "x" }, startedAt: "t", turns, checks };
  const s = summarizeRun(report);
  assert.equal(s.usefulMeasured, true);
  assert.equal(s.useful.max, 7000); assert.equal(s.firstAudio.max, 1000);
  assert.equal(s.usefulStalls10s, 1); assert.equal(s.fillerSegments, 2);
  const c = compareReports([{ report }]);
  assert.equal(c.perLine.find((l) => l.index === 6)!.byArm.x, "7.0 s (audio 0.8 s, 1 filler)");
  assert.equal(c.perLine.find((l) => l.index === 7)!.byArm.x, "FILLER ONLY (audio 1.0 s)");
});

import { PhoneDriver, driverSourceHash } from "../src/core/driver.ts";
import { mkdtempSync, writeFileSync as writeFile, mkdirSync as mkdir } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { join as joinPath } from "node:path";

test("the driver build stamp changes when any driver source changes", () => {
  const root = mkdtempSync(joinPath(tmp(), "mb-src-"));
  mkdir(joinPath(root, "Tests"));
  writeFile(joinPath(root, "Tests", "Driver.swift"), "case \"launch\":");
  const before = driverSourceHash(root);
  writeFile(joinPath(root, "Tests", "Driver.swift"), "case \"launch\": env");
  assert.notEqual(driverSourceHash(root), before);
  assert.match(driverSourceHash(), /^[0-9a-f]{64}$/); // the real sources hash
});

test("a launch with env is refused by a driver build that cannot apply it", async () => {
  const driver = Object.create(PhoneDriver.prototype) as PhoneDriver;
  (driver as unknown as { info: unknown }).info = { driver: "xcuitest" }; // an old build: no capabilities
  await assert.rejects(driver.run("launch", { env: { X: "1" } }), /does not support a launch environment/);
});

test("chime trains: a 0.3 s / 2.0 s alarm is found, speech is not", async () => {
  const { detectChimeTrains } = await import("../src/core/chime.ts");
  const segs: Array<{ startMs: number; endMs: number }> = [];
  // An alarm from 22.58 s, some pulses swallowed by two long replies.
  for (let t = 22580; t < 120000; t += 2000) if (!(t > 50000 && t < 64000) && !(t > 90000 && t < 100000)) segs.push({ startMs: t, endMs: t + 280 });
  const speech = [{ startMs: 51240, endMs: 62860 }, { startMs: 90500, endMs: 99000 }, { startMs: 101300, endMs: 101600 }];
  segs.push(...speech);
  const { trains, isChime } = detectChimeTrains(segs);
  assert.equal(trains.length, 1);
  assert.equal(trains[0].periodMs, 2000);
  assert.equal(trains[0].pulses, 37);
  for (const s of speech) assert.equal(isChime({ ...s }), false, `speech ${s.startMs} is not chime`);
  assert.equal(isChime({ startMs: 22580, endMs: 22860 }), true);
  // Short replies alone ("Okay.", "Yes.") at irregular times are not a train.
  assert.equal(detectChimeTrains([{ startMs: 1000, endMs: 1300 }, { startMs: 4700, endMs: 5000 }, { startMs: 9100, endMs: 9400 }, { startMs: 15800, endMs: 16100 }, { startMs: 17300, endMs: 17600 }]).trains.length, 0);
});

test("unprompted-speech check counts chime apart and adds alarm-ringing", async () => {
  const { evaluate } = await import("../src/core/assertions.ts");
  const turns = [{ index: 1, kind: "say" as const, text: "Done.", cueEndMs: 0, replyStartMs: 1000, replyEndMs: 3000, extraSegments: 0, chimeSegments: 12 }];
  const checks = evaluate({ turns, micAvailable: true, spokenLines: ["Done."], uiErrors: [], chimeTrains: [{ startMs: 4000, endMs: 28000, periodMs: 2000, pulses: 12 }] });
  const unprompted = checks.find((c) => c.id === "no-unprompted-speech")!;
  assert.equal(unprompted.verdict, "pass");
  assert.match(unprompted.detail, /12 alarm-chime pulse/);
  assert.equal(checks.find((c) => c.id === "alarm-ringing")?.verdict, "warn");
});
