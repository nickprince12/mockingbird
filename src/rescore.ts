/**
 * `mockingbird rescore <run dir> --adapter <adapter.ts> --scenario <scenario.json>` recomputes the
 * checks from a saved run (report.json + backend/), e.g. after a check
 * changes. Prints the checks; never rewrites the original report.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./core/assertions.ts";
import { loadAdapter } from "./adapters.ts";
import { applyHeard } from "./core/heard.ts";
import { summary, loadScenario, spokenLines } from "./run.ts";

const argv = process.argv.slice(2).filter((a) => a !== "rescore");
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (!dir) throw new Error("usage: mockingbird rescore <run dir> --adapter <adapter.ts> [--scenario <scenario.json>]");
const report = JSON.parse(readFileSync(join(dir, argv.includes("--input-rescore") ? "rescore.json" : "report.json"), "utf8"));
if (argv.includes("--resegment")) {
  const { resegment } = await import("./core/resegment.ts");
  const { writeWav, transcribe } = await import("./core/audio.ts");
  const { isNonSpeech } = await import("./run.ts");
  const { isFillerOnly } = await import("./core/filler.ts");
  const wav = readFileSync(join(dir, "mic.wav"));
  let offset = 12, pcm = Buffer.alloc(0);
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data") { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + size % 2;
  }
  if (!pcm.length) throw new Error("missing WAV data");
  const replay = resegment(pcm, report.timeline.playbacks);
  const output = join(dir, "rescore-audio"); mkdirSync(output, { recursive: true });
  for (let i = 0; i < report.turns.length; i++) {
    const t = report.turns[i], next = report.turns[i + 1];
    const end = next?.spokenAtMs ?? next?.cueEndMs ?? pcm.length / 32;
    const segments = replay.segments.filter(s => s.startMs >= t.cueEndMs && s.startMs < end).map((s, j) => {
      const file = join(output, `${t.index}-${j}.wav`);
      const clip = Buffer.from(pcm.subarray(Math.max(0, Math.floor(s.startMs * 32)), Math.floor(Math.min(s.endMs, end) * 32)));
      let peak = 0;
      for (let k = 0; k < clip.length; k += 2) peak = Math.max(peak, Math.abs(clip.readInt16LE(k)));
      // Normalize only derived transcription clips; the evidence WAV is untouched.
      if (peak) for (let k = 0; k < clip.length; k += 2) clip.writeInt16LE(Math.round(clip.readInt16LE(k) * 26000 / peak), k);
      writeWav(file, clip);
      const transcript = transcribe(file);
      return { ...s, transcript, nonSpeech: transcript === undefined ? undefined : isNonSpeech(transcript), filler: transcript === undefined ? undefined : isFillerOnly(transcript) };
    });
    for (const key of ['replyStartMs','replyEndMs','replyTranscript','replyNonSpeech','usefulStartMs','replyPeakDb','replyMarginDb']) delete t[key];
    t.segments = segments;
    if (segments.length) {
      t.replyStartMs = segments[0].startMs; t.replyEndMs = segments.at(-1)!.endMs;
      const replyFile = join(output, `${t.index}-reply.wav`);
      const replyClip = Buffer.from(pcm.subarray(Math.floor(Math.max(t.cueEndMs, t.replyStartMs - 150) * 32), Math.floor(Math.min(end, t.replyEndMs + 150) * 32)));
      let peak = 0;
      for (let k = 0; k < replyClip.length; k += 2) peak = Math.max(peak, Math.abs(replyClip.readInt16LE(k)));
      if (peak) for (let k = 0; k < replyClip.length; k += 2) replyClip.writeInt16LE(Math.round(replyClip.readInt16LE(k) * 26000 / peak), k);
      writeWav(replyFile, replyClip);
      t.replyTranscript = transcribe(replyFile);
      t.replyNonSpeech = t.replyTranscript === undefined ? undefined : isNonSpeech(t.replyTranscript);
      t.usefulStartMs = segments.find(s => !s.nonSpeech && !s.filler)?.startMs;
      t.replyPeakDb = Math.max(...segments.map(s => s.peakDb)); t.replyMarginDb = t.replyPeakDb - replay.noiseFloorDb;
      if (t.replyNonSpeech) { delete t.replyStartMs; delete t.replyEndMs; }
    }
  }
  const greeting = report.turns.find((t: any) => t.kind === 'greeting');
  report.startToFirstWordsMs = greeting?.replyStartMs === undefined ? undefined : greeting.replyStartMs - greeting.cueEndMs;
  report.timeline.speech = replay.segments;
  report.rescore = { source: 'mic.wav; local whisper; original report preserved', noiseFloorDb: replay.noiseFloorDb };
}
const adapter = await loadAdapter(value("--adapter"));
const loaded = loadScenario(value("--scenario") ?? report.scenario);
const scenario = adapter.configureScenario?.(loaded) ?? loaded;
if (argv.includes("--refresh-receipts")) {
  if (!adapter.refreshReceipts) throw new Error("adapter does not support --refresh-receipts");
  await adapter.refreshReceipts(report);
}
const appEvidence = adapter.appEvidence?.(report.backendTrace?.data);
const scoringReport = { heardAs: report.heardAs, ...report, appEvidence, criticalWords: adapter.criticalWords };
applyHeard(scoringReport, scenario.steps);
report.heardAs = scoringReport.heardAs;
const evidence = adapter.evidenceFromRunDir?.(dir, report);
const checks = evaluate({ turns: report.turns, micAvailable: report.micAvailable ?? !report.checks.some((c: { id: string }) => c.id === "mac-microphone"),
  startToFirstWordsMs: report.startToFirstWordsMs, voiceStartWall: report.voiceStartWall, backend: evidence, spokenLines: spokenLines(scenario),
  labelsSeen: report.labelsSeen?.length ? report.labelsSeen : undefined, calibration: report.calibration, statusSamples: report.statusSamples,
  forbiddenWords: scenario.forbiddenWords, expectWords: Object.fromEntries(scenario.steps.flatMap((s, i) => s.expectWords ? [[i + 1, s.expectWords]] : [])), forbidWords: Object.fromEntries(scenario.steps.flatMap((s, i) => "forbidWords" in s && s.forbidWords ? [[i + 1, s.forbidWords]] : [])), status: scenario.status, thresholds: scenario.thresholds, uiErrors: [] });
for (const c of checks) console.log(`${c.verdict.padEnd(10)} ${c.id.padEnd(28)} ${c.detail}`);

const { classifyHealth } = await import('./core/health.ts');
// Recompute acoustic/backend checks; preserve every original non-audio check,
// including duplicates (e.g. multiple UI errors). Offline replay cannot undo them.
const retained = report.checks.filter((c: any) => !['acoustic', 'backend', 'rig/infra'].includes(c.source));
const retainedIds = new Set(retained.map((c: any) => c.id));
for (let i = checks.length - 1; i >= 0; i--) if (retainedIds.has(checks[i].id)) checks.splice(i, 1);
checks.push(...retained);
for (const c of report.checks) if (c.source === 'backend' && !checks.some(n => n.id === c.id)) checks.push(c);
const { captureDiagnosis } = await import('./core/captureDiagnosis.ts');
checks.push(...captureDiagnosis(scoringReport));
report.checks = checks;
report.verdict = checks.some(c => c.verdict === 'fail') ? 'FAIL' : checks.some(c => c.verdict === 'unmeasured') ? 'INCOMPLETE' : 'PASS';
report.health = classifyHealth({ checks, startToFirstWordsMs: report.startToFirstWordsMs });
writeFileSync(join(dir, 'rescore.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.health));

writeFileSync(join(dir, "summary.md"), summary(report, checks, report.turns, report.backendTrace ? { ...report.backendTrace, markdown: report.backendTrace.markdown ?? "Saved backend trace data retained in report.json and rescore.json; no archive re-pull during offline rescore." } : undefined));
