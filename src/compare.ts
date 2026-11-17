import { percent } from './core/heard.ts';
/**
 * A side-by-side comparison of runs of the same script under different arms
 * (engines, backends, builds): `mockingbird compare <run dir or report.json>...`
 * writes comparison.md + comparison.json next to them (or to --out <dir>).
 * `mockingbird matrix` calls the same code when its arms finish.
 *
 * Everything here is computed from each run's report.json; nothing is
 * re-measured. Latency is the calibrated gap from the audible end of a line to
 * the onset of the app's reply (acoustic), so arms are compared on what a user
 * would hear, whichever backend they use.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface Turn { index: number; kind: string; text?: string; expect?: string; cueEndMs: number; replyStartMs?: number; replyEndMs?: number; replyTranscript?: string; extraSegments?: number; chimeSegments?: number;
  segments?: Array<{ transcript?: string; filler?: boolean }>; usefulStartMs?: number; fillerSegments?: number }
interface Check { id: string; verdict: string; source: string; detail: string }
export interface RunReport {
  heardAs?: { sttProvider: string; wer: number | null; criticalErrorRate: number | null; groups: Array<{indices:number[]; alignment:string; score?:{wer:number|null;criticalErrorRate:number|null}}> };
  verdict: string; scenario: string; arm?: { id: string; label?: string; launchEnv?: Record<string, string> };
  startedAt: string; startToFirstWordsMs?: number; spendUsd?: number; turns: Turn[]; checks: Check[];
}

export interface Latency { p50?: number; p90?: number; max?: number; maxAfter?: string }
export interface ArmSummary {
  heardAs?: RunReport["heardAs"];
  arm: string; label?: string; scenario: string; verdict: string; startedAt: string; runDir?: string;
  completed: boolean; abortedBecause?: string;
  /** Opening: first audio, and first useful (non-filler) words. */
  firstWordsMs?: number; firstUsefulWordsMs?: number;
  replies: number; asked: number; unanswered: string[];
  /**
   * HEADLINE: end of the line to the first reply segment that is not filler
   * (core/filler.ts). False when the run has no segment transcripts (older
   * report, or no whisper): useful figures then fall back to first audio.
   */
  usefulMeasured: boolean;
  useful: Latency;
  /** Lines whose useful reply took 10 s or more, came as filler only, or never came. */
  usefulStalls10s: number;
  /** Secondary: end of the line to the first audio of any kind, filler included. */
  firstAudio: Latency;
  /** Filler-only segments ("Checking.", "One moment."), and the lines they followed. */
  fillerSegments: number; fillerExamples: string[];
  /** Speech after a reply had ended with no new line (self-echo or a second answer). */
  unpromptedSegments: number;
  /** Alarm-chime pulses (a ringing alarm, core/chime.ts), never counted as speech. */
  alarmPulses: number;
  selfEchoTurns?: string;
  rules: { pass: number; fail: number; unmeasured: number; failed: string[] };
  spendUsd?: number;
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
/** Rule checks: what the script says the app must (not) say or do. */
const isRule = (id: string) => /^(reply-words|reply-not-words|forbidden-words|ui-step|status-|silent-line|advances#|run-completed)/.test(id);

/** The column name: the arm, else the run folder (saved runs without an arm). */
export const armKey = (report: RunReport, runDir?: string, i = 0) => report.arm?.id ?? (runDir ? basename(runDir) : `run ${i + 1}`);

const latency = (rows: Array<{ t: Turn; ms: number }>): Latency => {
  const slowest = [...rows].sort((a, b) => b.ms - a.ms)[0];
  return { p50: percentile(rows.map((l) => l.ms), 50), p90: percentile(rows.map((l) => l.ms), 90), max: slowest?.ms, maxAfter: slowest ? slowest.t.text ?? slowest.t.kind : undefined };
};
/** Has this turn's reply been split into transcribed segments? */
const segmented = (t: Turn) => t.fillerSegments !== undefined;
/** Useful onset of a turn: its first non-filler segment; first audio when the run has no segment transcripts. */
export const usefulOnset = (t: Turn) => (segmented(t) ? t.usefulStartMs : t.replyStartMs);

export function summarizeRun(report: RunReport, runDir?: string, i = 0): ArmSummary {
  const asked = report.turns.filter((t) => (t.kind === "say" || t.kind === "resume") && t.expect !== "silence");
  const answered = asked.filter((t) => t.replyStartMs !== undefined);
  const usefulRows = answered.filter((t) => usefulOnset(t) !== undefined).map((t) => ({ t, ms: usefulOnset(t)! - t.cueEndMs }));
  const rules = report.checks.filter((c) => isRule(c.id));
  const aborted = report.checks.find((c) => c.id === "run-completed" && c.verdict === "fail");
  const greeting = report.turns.find((t) => t.kind === "greeting");
  const fillers = report.turns.flatMap((t) => (t.segments ?? []).filter((g) => g.filler).map((g) => `${JSON.stringify(g.transcript)} after ${t.text ? JSON.stringify(t.text) : t.kind}`));
  return {
    heardAs: report.heardAs ? { ...report.heardAs, groups: report.heardAs.groups.map(g=>({indices:g.indices,alignment:g.alignment,score:g.score})) } : undefined,
    arm: armKey(report, runDir, i), label: report.arm?.label, scenario: report.scenario, verdict: report.verdict, startedAt: report.startedAt, runDir,
    completed: !aborted, abortedBecause: aborted?.detail,
    firstWordsMs: report.startToFirstWordsMs ?? (greeting?.replyStartMs !== undefined ? greeting.replyStartMs - greeting.cueEndMs : undefined),
    firstUsefulWordsMs: greeting && usefulOnset(greeting) !== undefined ? usefulOnset(greeting)! - greeting.cueEndMs : undefined,
    replies: answered.length, asked: asked.length,
    unanswered: asked.filter((t) => t.replyStartMs === undefined).map((t) => t.text ?? t.kind),
    usefulMeasured: answered.some(segmented),
    useful: latency(usefulRows),
    usefulStalls10s: usefulRows.filter((l) => l.ms >= 10000).length + asked.filter((t) => usefulOnset(t) === undefined).length,
    firstAudio: latency(answered.map((t) => ({ t, ms: t.replyStartMs! - t.cueEndMs }))),
    fillerSegments: fillers.length, fillerExamples: fillers.slice(0, 8),
    unpromptedSegments: report.turns.reduce((n, t) => n + (t.extraSegments ?? 0), 0),
    alarmPulses: report.turns.reduce((n, t) => n + (t.chimeSegments ?? 0), 0),
    selfEchoTurns: report.checks.find((c) => c.id === "no-self-echo-turns")?.verdict,
    rules: { pass: rules.filter((c) => c.verdict === "pass").length, fail: rules.filter((c) => c.verdict === "fail").length,
      unmeasured: rules.filter((c) => c.verdict === "unmeasured").length, failed: rules.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.detail}`) },
    spendUsd: report.spendUsd || undefined,
  };
}

const secs = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

export function compareReports(entries: Array<{ report: RunReport; runDir?: string }>) {
  const arms = entries.map((e, i) => summarizeRun(e.report, e.runDir, i));
  // Per-line table: the same script, so the same step index means the same line.
  const lines = new Map<number, { cue: string; byArm: Record<string, string> }>();
  for (const [i, { report, runDir }] of entries.entries()) {
    const key = armKey(report, runDir, i);
    for (const t of report.turns) {
      const row = lines.get(t.index) ?? { cue: t.kind === "say" ? JSON.stringify(t.text) : t.kind, byArm: {} };
      const first = t.replyStartMs !== undefined ? t.replyStartMs - t.cueEndMs : undefined;
      const onset = usefulOnset(t);
      const useful = onset !== undefined ? onset - t.cueEndMs : undefined;
      row.byArm[key] = first === undefined ? (t.expect === "silence" ? "silent (expected)" : "NO REPLY")
        : useful === undefined ? `FILLER ONLY (audio ${secs(first)})`
        : `${secs(useful)}${useful >= 10000 ? " STALL" : ""}${useful - first >= 300 ? ` (audio ${secs(first)}, ${t.fillerSegments} filler)` : ""}`;
      lines.set(t.index, row);
    }
  }
  const perLine = [...lines].sort((a, b) => a[0] - b[0]).map(([index, row]) => ({ index, ...row }));
  return { generatedAt: new Date().toISOString(), arms, perLine };
}

export function comparisonMarkdown(comparison: ReturnType<typeof compareReports>, title = "Engine comparison"): string {
  const ids = comparison.arms.map((a) => a.arm);
  const head = `| | ${comparison.arms.map((a) => a.label ? `${a.arm} (${a.label})` : a.arm).join(" | ")} |\n|---|${ids.map(() => "---").join("|")}|`;
  const row = (name: string, f: (a: ArmSummary) => string) => `| ${name} | ${comparison.arms.map((a) => cell(f(a))).join(" | ")} |`;
  const table = [head,
    row("STT provider", a=>a.heardAs?.sttProvider ?? 'unavailable'),
    row("heard-as WER", a=>percent(a.heardAs?.wer)),
    row("critical-token error rate", a=>percent(a.heardAs?.criticalErrorRate)),
    row("verdict", (a) => `${a.verdict}${a.completed ? "" : " (stopped early)"}`),
    row("**useful reply p50**", (a) => secs(a.useful.p50)),
    row("**useful reply p90**", (a) => secs(a.useful.p90)),
    row("**useful reply max**", (a) => a.useful.max === undefined ? "—" : `${secs(a.useful.max)} after ${a.useful.maxAfter}`),
    row("**10 s+ useful-reply stalls**", (a) => String(a.usefulStalls10s)),
    row("filler segments", (a) => String(a.fillerSegments)),
    row("first useful words (opening)", (a) => secs(a.firstUsefulWordsMs)),
    row("answered (any audio)", (a) => `${a.replies} of ${a.asked}`),
    row("unprompted speech segments", (a) => String(a.unpromptedSegments)),
    row("alarm chime pulses (ringing alarm, not speech)", (a) => String(a.alarmPulses)),
    row("self-echo turns (backend)", (a) => a.selfEchoTurns ?? "n/a"),
    row("rule checks pass / fail / unmeasured", (a) => `${a.rules.pass} / ${a.rules.fail} / ${a.rules.unmeasured}`),
    row("spend", (a) => a.spendUsd === undefined ? "not tracked" : `$${a.spendUsd.toFixed(3)}`),
    row("_secondary: first audio p50 / p90 / max_", (a) => `${secs(a.firstAudio.p50)} / ${secs(a.firstAudio.p90)} / ${secs(a.firstAudio.max)}`),
    row("_secondary: first words (opening, any audio)_", (a) => secs(a.firstWordsMs)),
  ].join("\n");
  const lineHead = `| # | line | ${ids.join(" | ")} |\n|---|---|${ids.map(() => "---").join("|")}|`;
  const lineRows = comparison.perLine.map((l) => `| ${l.index} | ${cell(l.cue)} | ${ids.map((id) => l.byArm[id] ?? "—").join(" | ")} |`).join("\n");
  const failures = comparison.arms.map((a) => `### ${a.arm}${a.runDir ? ` — \`${a.runDir}\`` : ""}\n\n${a.abortedBecause ? `Stopped early: ${a.abortedBecause}\n\n` : ""}${a.unanswered.length ? `Unanswered: ${a.unanswered.map((u) => JSON.stringify(u)).join(", ")}\n\n` : ""}${a.fillerExamples.length ? `Filler: ${a.fillerExamples.map(cell).join("; ")}\n\n` : ""}${a.rules.failed.length ? a.rules.failed.map((f) => `- ${cell(f)}`).join("\n") : "No rule check failed."}`).join("\n\n");
  const heardIndices=[...new Set(comparison.arms.flatMap(a=>a.heardAs?.groups.flatMap(g=>g.indices) ?? []))].sort((a,b)=>a-b);
  const heardTable=`## Heard-as per line (WER / critical-token error rate)\n\nMerged lines share one group score, not separate per-line measurements. Transcript text stays in each run directory.\n\n| step | ${ids.join(' | ')} |\n|---|${ids.map(()=>'---').join('|')}|\n` + heardIndices.map(i=>`| ${i} | ${comparison.arms.map(a=>{const g=a.heardAs?.groups.find(g=>g.indices.includes(i));return g?`${percent(g.score?.wer)} / ${percent(g.score?.criticalErrorRate)} (${g.alignment}${g.indices.length>1?'; steps '+g.indices.join(', '):''})`:'unmeasured';}).join(' | ')} |`).join('\n');
  return `# ${title}\n\nGenerated ${comparison.generatedAt}. **Headline: time to a useful reply**: the audible end of the user's line to the onset of the first reply segment that is not filler ("Checking", "One moment", "Mm-hm", ...; core/filler.ts, judged on the Mac's local whisper transcript of each segment). Filler is counted separately as its own cost. A useful reply of 10 s or more, a filler-only reply, or no reply is a stall. First audio (filler included) is secondary. Rule checks: reply-words, reply-not-words, forbidden-words, ui-step, status, advances.${comparison.arms.some((a) => !a.usefulMeasured) ? " Runs without segment transcripts (older reports, or no whisper) fall back to first audio for the useful figures: " + comparison.arms.filter((a) => !a.usefulMeasured).map((a) => a.arm).join(", ") + "." : ""}\n\n${table}\n\n${heardTable}\n\n## Per line (time to a useful reply; first audio in brackets when filler came first)\n\n${lineHead}\n${lineRows}\n\n## Failures by arm\n\n${failures}\n`;
}

/** Read report.json from run folders (or report paths), write comparison.md/.json to outDir. */
export function writeComparison(inputs: string[], outDir: string, title?: string) {
  const entries = inputs.map((input) => {
    const path = existsSync(input) && statSync(input).isDirectory() ? join(input, "report.json") : input;
    return { report: JSON.parse(readFileSync(path, "utf8")) as RunReport, runDir: dirname(resolve(path)) };
  });
  const comparison = compareReports(entries);
  writeFileSync(join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
  writeFileSync(join(outDir, "comparison.md"), comparisonMarkdown(comparison, title));
  return comparison;
}

export async function main(argv = process.argv.slice(3)) {
  // Every option takes a value (--out, and the runner's --adapter/--scenarios-dir/--reports); the rest are runs.
  const inputs: string[] = []; let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i].startsWith("--")) i++;
    else inputs.push(argv[i]);
  }
  if (!inputs.length) throw new Error("usage: mockingbird compare <run dir or report.json>... [--out <dir>]");
  const dir = out ?? dirname(resolve(inputs[0]));
  mkdirSync(dir, { recursive: true });
  writeComparison(inputs, dir);
  console.log(join(dir, "comparison.md"));
}
