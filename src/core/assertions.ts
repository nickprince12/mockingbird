/**
 * Pass/fail checks over one run. Independent sources, each labelled on every
 * result so a verdict always says where it came from:
 *   - acoustic: what the Mac mic heard (onsets, silences, local transcripts);
 *   - backend: the app backend's own records for this run (what it said and
 *     heard, its trace of output starting, its state mutations), supplied by
 *     the app adapter;
 *   - screen: what the driver read on the phone.
 * A check with no evidence is "unmeasured", never a pass. A check whose
 * source cannot exist for this run by design (backend records from a hosted
 * backend the runner cannot read) is "n/a": it never fails and never passes,
 * and does not make the run INCOMPLETE.
 */
import type { BackendEvidence } from "./types.ts";

export type Verdict = "pass" | "fail" | "warn" | "unmeasured" | "n/a";
export interface CheckResult { id: string; verdict: Verdict; source: string; detail: string }

export interface TurnRecord {
  index: number;
  kind: "say" | "greeting" | "resume";
  text?: string;
  expect?: "advance" | "silence";
  /** Mic clock, ms. */
  cueEndMs: number;
  /** Mac wall clock when the cue finished (pairs with backend timestamps). */
  cueEndWall?: number;
  /** When the line actually started playing (mic ms and wall), and how it was timed. */
  spokenAtMs?: number;
  spokenAtWall?: number;
  overlappedAppSpeech?: boolean;
  rigFailure?: "spoke-over-app";
  notes?: string[];
  timing?: { mode: "after-quiet" | "overlap" | "after-onset"; waitedMs?: number; timedOut?: boolean; quietMs?: number; overlapMs?: number };
  replyStartMs?: number;
  replyEndMs?: number;
  replyTranscript?: string;
  replyWords?: { text?: string; source: string; provenance: string };
  /** Sound was detected but the local transcript says it was not speech (a thud, typing). */
  replyNonSpeech?: boolean;
  /** Loudest frame of the reply and its margin over the noise floor, in dB. */
  replyPeakDb?: number;
  replyMarginDb?: number;
  progressBefore?: string;
  progressAfter?: string;
  /** Unprompted app speech after this reply ended and before the next cue. */
  extraSegments: number;
  /** Alarm-chime pulses (core/chime.ts) in the same window: an alarm ringing, not the app talking. */
  chimeSegments?: number;
  /** The reply's speech segments, each transcribed on its own and classed as filler or not (core/filler.ts). */
  segments?: Array<{ startMs: number; endMs: number; transcript?: string; filler?: boolean; nonSpeech?: boolean; chime?: boolean }>;
  /** Onset of the first segment that is not filler: time to a USEFUL reply. Undefined: no useful speech (or no transcripts). */
  usefulStartMs?: number;
  /** Filler-only segments in this reply ("Checking.", "One moment."). */
  fillerSegments?: number;
}

export interface Thresholds { firstWordsMs: number; replyWarnMs: number; replyFailMs: number }
export const defaultThresholds: Thresholds = { firstWordsMs: 10000, replyWarnMs: 6000, replyFailMs: 10000 };

export interface StatusExpectation {
  present?: string[]; absent?: string[];
  /** Must appear in EVERY status read taken while voice was running (e.g. an engine label). */
  presentInEverySample?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);

function overlap(a: string, b: string): number {
  const A = new Set(words(a)), B = words(b);
  if (!A.size || !B.length) return 0;
  return B.filter((w) => A.has(w)).length / Math.max(A.size, B.length);
}

/** Sentence-level lines, for the repeated-line check. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(norm).filter((s) => s.split(" ").length >= 5);
}

export function evaluate(input: {
  turns: TurnRecord[];
  micAvailable: boolean;
  /** Acoustic: voice start (mic clock) to first heard onset. */
  startToFirstWordsMs?: number;
  /** Wall time of the UI step that started voice. */
  voiceStartWall?: number;
  backend?: BackendEvidence;
  /** The lines the speaker played that the app should have heard. */
  spokenLines: string[];
  /** Every label seen on screen during the session, and what must / must not appear. */
  labelsSeen?: string[];
  /** Status reads taken while voice was running, in order. */
  statusSamples?: string[][];
  /** Per-line expected words in the app's reply (regex, case-insensitive), keyed by turn index. */
  expectWords?: Record<number, string>;
  /** Step index -> regex the reply must NOT match. */
  forbidWords?: Record<number, string>;
  /** Phrases the app must never say in any reply (regex, case-insensitive). */
  forbiddenWords?: string[];
  status?: StatusExpectation;
  /** Alarm-chime pulse trains heard during the run (core/chime.ts). */
  chimeTrains?: import("./chime.ts").ChimeTrain[];
  thresholds?: Partial<Thresholds>;
  /** Playback-to-mic calibration; when present and invalid, acoustic latency never passes. */
  calibration?: { valid: boolean; offsetMs?: number; spreadMs?: number; reason?: string };
  uiErrors: string[];
}): CheckResult[] {
  const t = { ...defaultThresholds, ...input.thresholds };
  const out: CheckResult[] = [];
  const { turns, backend } = input;
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const latencyInvalid = input.calibration && !input.calibration.valid ? `latency not trusted: ${input.calibration.reason}` : undefined;
  if (input.calibration) out.push({ id: "audio-calibration", source: "acoustic", verdict: input.calibration.valid ? "pass" : "fail",
    detail: input.calibration.valid ? `playback-to-mic offset ${input.calibration.offsetMs} ms (spread ${input.calibration.spreadMs} ms), subtracted from reply latency` : String(input.calibration.reason) });

  if (input.startToFirstWordsMs !== undefined && latencyInvalid) {
    out.push({ id: "first-words", source: "acoustic", verdict: "unmeasured", detail: `${secs(input.startToFirstWordsMs)} measured, but ${latencyInvalid}` });
  } else if (input.startToFirstWordsMs !== undefined) {
    out.push({ id: "first-words", source: "acoustic", verdict: input.startToFirstWordsMs < t.firstWordsMs ? "pass" : "fail", detail: `${secs(input.startToFirstWordsMs)} from voice start to first heard words (bar ${secs(t.firstWordsMs)}; mic onset, includes up to ~0.2 s VAD latency)` });
  } else {
    out.push({ id: "first-words", source: "acoustic", verdict: input.micAvailable ? "fail" : "unmeasured", detail: input.micAvailable ? "no first words heard" : "no Mac microphone" });
  }
  const na = backend?.unavailable;
  if (na) {
    out.push({ id: "first-words:app-trace", source: "backend", verdict: "n/a", detail: na });
  } else if (input.voiceStartWall !== undefined && backend?.firstOutputWalls) {
    const first = backend.firstOutputWalls.filter((w) => w >= input.voiceStartWall!).sort((a, b) => a - b)[0];
    out.push(first === undefined
      ? { id: "first-words:app-trace", source: "backend", verdict: "fail", detail: "no output-start event after voice start" }
      : { id: "first-words:app-trace", source: "backend", verdict: first - input.voiceStartWall < t.firstWordsMs ? "pass" : "fail", detail: `${secs(first - input.voiceStartWall)} from voice start to the app's own first-output event (device clock vs Mac clock; equal on a Simulator)` });
  }

  const contaminated = turns.filter(x => x.rigFailure === "spoke-over-app");
  for (const x of contaminated) out.push({ id: `spoke-over-app#${x.index}`, source: "rig/infra", verdict: "fail", detail: `spoke-over-app: step ${x.index} overlapped app speech and has no app transcript` });
  const asked = turns.filter((x) => !x.rigFailure && (x.kind === "say" || x.kind === "resume"));
  if (input.micAvailable) {
    const dropped = asked.filter((x) => x.expect !== "silence" && x.replyStartMs === undefined);
    const answeredWhenSilent = asked.filter((x) => x.expect === "silence" && x.replyStartMs !== undefined);
    const answerable = asked.filter((x) => x.expect !== "silence").length;
    out.push({ id: "every-utterance-answered", source: "acoustic", verdict: dropped.length ? "fail" : "pass",
      detail: dropped.length ? `no reply to: ${dropped.map((x) => JSON.stringify(x.text ?? x.kind)).join(", ")}` : `${answerable} of ${answerable} answered` });
    if (asked.some((x) => x.expect === "silence")) out.push({ id: "silent-line-not-answered", source: "acoustic", verdict: answeredWhenSilent.length ? "fail" : "pass",
      detail: answeredWhenSilent.length ? `answered a line that expected silence: ${answeredWhenSilent.map((x) => JSON.stringify(x.text)).join(", ")}` : "no reply where silence was expected" });
    // Headline: time to the first USEFUL speech (filler does not count). First
    // audio is reported too, as a secondary figure that never fails a run.
    const answerableTurns = asked.filter((x) => x.expect !== "silence");
    const transcribed = answerableTurns.filter((x) => x.replyStartMs !== undefined && x.segments?.some((g) => g.transcript !== undefined));
    if (latencyInvalid) out.push({ id: "useful-reply-latency", source: "acoustic", verdict: "unmeasured", detail: latencyInvalid });
    else if (answerableTurns.some((x) => x.replyStartMs !== undefined) && !transcribed.length) out.push({ id: "useful-reply-latency", source: "acoustic", verdict: "unmeasured", detail: "no segment transcripts (whisper unavailable), so filler cannot be told from an answer" });
    else if (transcribed.length) {
      const useful = transcribed.filter((x) => x.usefulStartMs !== undefined).map((x) => ({ x, ms: x.usefulStartMs! - x.cueEndMs })).sort((a, b) => b.ms - a.ms);
      const fillerOnly = transcribed.filter((x) => x.usefulStartMs === undefined);
      const slow = useful[0];
      out.push({ id: "useful-reply-latency", source: "acoustic",
        verdict: fillerOnly.length || (slow && slow.ms >= t.replyFailMs) ? "fail" : slow && slow.ms >= t.replyWarnMs ? "warn" : "pass",
        detail: [slow ? `slowest useful reply ${secs(slow.ms)} after ${JSON.stringify(slow.x.text ?? slow.x.kind)} (end of the line to the first non-filler speech, calibrated)` : "",
          fillerOnly.length ? `only filler after: ${fillerOnly.map((x) => JSON.stringify(x.text ?? x.kind)).join(", ")}` : ""].filter(Boolean).join("; ") });
      const stalls = [...useful.filter((u) => u.ms >= 10000).map((u) => `${JSON.stringify(u.x.text ?? u.x.kind)} ${secs(u.ms)}`), ...fillerOnly.map((x) => `${JSON.stringify(x.text ?? x.kind)} filler only`)];
      out.push({ id: "useful-reply-stalls", source: "acoustic", verdict: stalls.length ? "fail" : "pass", detail: stalls.length ? `10 s+ to a useful reply: ${stalls.join("; ")}` : "every useful reply under 10 s" });
    }
    const fillers = turns.flatMap((x) => (x.segments ?? []).filter((g) => g.filler).map((g) => ({ x, g })));
    if (transcribed.length) out.push({ id: "filler-segments", source: "acoustic", verdict: fillers.length ? "warn" : "pass",
      detail: fillers.length ? `${fillers.length} filler segment(s): ${fillers.slice(0, 6).map(({ x, g }) => `${JSON.stringify(g.transcript)} after ${JSON.stringify(x.text ?? x.kind)}`).join("; ")}` : "none" });
    const slowest = asked.filter((x) => x.replyStartMs !== undefined).map((x) => ({ x, ms: x.replyStartMs! - x.cueEndMs })).sort((a, b) => b.ms - a.ms)[0];
    if (slowest && latencyInvalid) out.push({ id: "first-audio-latency", source: "acoustic", verdict: "unmeasured", detail: `slowest ${secs(slowest.ms)} measured, but ${latencyInvalid}` });
    else if (slowest) out.push({ id: "first-audio-latency", source: "acoustic", verdict: slowest.ms >= t.replyWarnMs ? "warn" : "pass", detail: `secondary: slowest first audio ${secs(slowest.ms)} after ${JSON.stringify(slowest.x.text ?? slowest.x.kind)} (filler counts here; the headline is useful-reply-latency)` });
    // How close the app's speech came to the detection threshold: the signal
    // for choosing the lowest reliable device volume (and re-calibrating).
    const margins = turns.filter((x) => x.replyStartMs !== undefined && x.replyMarginDb !== undefined).map((x) => ({ x, m: x.replyMarginDb! }));
    if (margins.length) {
      const quietest = margins.sort((a, b) => a.m - b.m)[0];
      out.push({ id: "reply-level-margin", source: "acoustic", verdict: quietest.m < 10 ? "warn" : "pass",
        detail: `quietest reply ${quietest.m.toFixed(1)} dB over the noise floor (peak ${quietest.x.replyPeakDb?.toFixed(1)} dBFS, after ${JSON.stringify(quietest.x.text ?? quietest.x.kind)}); median ${margins.map((a) => a.m).sort((a, b) => a - b)[Math.floor(margins.length / 2)].toFixed(1)} dB. Under 10 dB: raise the device volume a step or re-calibrate` });
    }
    const extra = turns.reduce((n, x) => n + x.extraSegments, 0);
    const chimed = turns.reduce((n, x) => n + (x.chimeSegments ?? 0), 0);
    out.push({ id: "no-unprompted-speech", source: "acoustic", verdict: extra ? "warn" : "pass", detail: (extra ? `${extra} speech segment(s) after a reply had finished with no new cue (self-echo or a second answer)` : "none") + (chimed ? `; ${chimed} alarm-chime pulse(s) not counted (see alarm-ringing)` : "") });
    const trains = input.chimeTrains ?? [];
    if (trains.length) {
      const pulses = trains.reduce((n, t) => n + t.pulses, 0);
      out.push({ id: "alarm-ringing", source: "acoustic", verdict: "warn",
        detail: `an alarm chime rang: ${trains.map((t) => `${t.pulses} pulses every ${(t.periodMs / 1000).toFixed(1)} s from ${secs(t.startMs)} to ${secs(t.endMs)} (mic clock)`).join("; ")}; ${pulses} pulse(s) in all. Reply timings near it may include chime` });
    }
  } else {
    out.push({ id: "every-utterance-answered", source: "acoustic", verdict: "unmeasured", detail: "no Mac microphone" });
  }

  if (backend && backend.sessions.length) {
    const lines = backend.assistant.flatMap((a) => sentences(a.text));
    const seen = new Map<string, number>();
    for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1);
    const repeated = [...seen].filter(([, n]) => n > 1);
    out.push({ id: "no-repeated-line", source: "backend", verdict: repeated.length ? "fail" : "pass", detail: repeated.length ? `repeated: ${repeated.map(([l, n]) => `"${l}" x${n}`).join("; ")}` : `${lines.length} distinct lines of 5+ words` });

    // Self-echo: something the app "heard" that is its own earlier speech, not a played line.
    const echoes = backend.user.filter((u) => {
      const fromSpeaker = input.spokenLines.some((r) => overlap(r, u.text) >= 0.6);
      const fromApp = backend.assistant.some((a) => a.atIso <= u.atIso && overlap(a.text, u.text) >= 0.6 && words(u.text).length >= 3);
      return !fromSpeaker && fromApp;
    });
    out.push({ id: "no-self-echo-turns", source: "backend", verdict: echoes.length ? "fail" : "pass", detail: echoes.length ? `heard its own speech: ${echoes.map((e) => JSON.stringify(e.text)).join(", ")}` : `${backend.user.length} heard utterances, none are the app's own speech` });

    const productSpokenLines = [...input.spokenLines];
    for (const turn of contaminated) {
      const i = productSpokenLines.indexOf(turn.text ?? '');
      if (i >= 0) productSpokenLines.splice(i, 1);
    }
    const heard = productSpokenLines.filter((r) => backend.user.some((u) => overlap(r, u.text) >= 0.5));
    out.push({ id: "app-heard-the-speaker", source: "backend", verdict: heard.length === productSpokenLines.length ? "pass" : heard.length ? "warn" : "fail", detail: `${heard.length} of ${productSpokenLines.length} played lines appear in what the app heard` });
  } else {
    out.push({ id: "no-repeated-line", source: "backend", verdict: na ? "n/a" : "unmeasured", detail: na ?? "no backend records for this run" });
  }

  // expect "advance": the backend's state-mutation events first (between this
  // cue and the next), the screen's progress text as a fallback.
  const cueWalls = turns.map((x) => x.cueEndWall).filter((w): w is number => w !== undefined).sort((a, b) => a - b);
  for (const turn of turns.filter((x) => x.expect === "advance")) {
    const id = `advances#${turn.index}`;
    if (turn.rigFailure) { out.push({ id, source: 'rig/infra', verdict: 'unmeasured', detail: 'spoke-over-app: product advancement not graded' }); continue; }
    if (!na && backend?.advanceEvents && turn.cueEndWall !== undefined) {
      const until = cueWalls.find((w) => w > turn.cueEndWall!) ?? Number.POSITIVE_INFINITY;
      const hits = backend.advanceEvents.filter((e) => e.atWall >= turn.cueEndWall! - 500 && e.atWall < until).map((e) => e.what);
      out.push({ id, source: "backend", verdict: hits.length ? "pass" : "fail", detail: hits.length ? hits.join(", ") : "no state-advancing event before the next cue" });
      continue;
    }
    if (!turn.progressBefore && !turn.progressAfter && na) { out.push({ id, source: "screen", verdict: "n/a", detail: `the screen showed no progress text and backend records are unavailable: ${na}` }); continue; }
    if (!turn.progressBefore && !turn.progressAfter) { out.push({ id, source: "screen", verdict: "unmeasured", detail: "the screen showed no progress text (some apps show none mid-task) and no backend evidence was available" }); continue; }
    const moved = turn.progressBefore !== turn.progressAfter;
    out.push({ id, source: "screen", verdict: moved ? "pass" : "fail", detail: moved ? `"${turn.progressBefore}" -> "${turn.progressAfter}"` : `unchanged: "${turn.progressBefore}"` });
  }

  if (input.status && (input.status.present?.length || input.status.absent?.length)) {
    if (!input.labelsSeen) out.push({ id: "status-labels", source: "screen", verdict: "unmeasured", detail: "screen not read during the session" });
    else {
      const has = (needle: string) => input.labelsSeen!.some((l) => l.toLowerCase().includes(needle.toLowerCase()));
      const missing = (input.status.present ?? []).filter((p) => !has(p));
      const unwanted = (input.status.absent ?? []).filter((a) => has(a));
      out.push({ id: "status-labels", source: "screen", verdict: missing.length || unwanted.length ? "fail" : "pass",
        detail: [missing.length ? `missing: ${missing.join(", ")}` : "", unwanted.length ? `should be absent: ${unwanted.join(", ")}` : "",
          !missing.length && !unwanted.length ? `present: ${(input.status.present ?? []).join(", ") || "-"}; absent: ${(input.status.absent ?? []).join(", ") || "-"}` : ""].filter(Boolean).join("; ") });
    }
  }

  for (const needle of input.status?.presentInEverySample ?? []) {
    const samples = input.statusSamples ?? [];
    if (!samples.length) { out.push({ id: `status-every-sample:${needle}`, source: "screen", verdict: "unmeasured", detail: "no status reads during the session" }); continue; }
    const missing = samples.map((s, i) => ({ s, i })).filter(({ s }) => !s.some((l) => l.toLowerCase().includes(needle.toLowerCase())));
    out.push({ id: `status-every-sample:${needle}`, source: "screen", verdict: missing.length ? "fail" : "pass",
      detail: missing.length ? `${missing.length} of ${samples.length} status reads lacked "${needle}": ${missing.slice(0, 4).map(({ s, i }) => `#${i + 1} [${s.join(" / ") || "no status"}]`).join("; ")}` : `"${needle}" in all ${samples.length} status reads` });
  }

  // What the app said, from the local transcript of each reply (approximate:
  // whisper, not the app's own transcript).
  for (const [indexText, pattern] of Object.entries(input.expectWords ?? {})) {
    const turn = turns.find((x) => x.index === Number(indexText));
    const id = `reply-words#${indexText}`;
    if (turn?.rigFailure === 'spoke-over-app') { out.push({ id, source: 'rig/infra', verdict: 'unmeasured', detail: 'spoke-over-app: no app transcript; product reply expectation not graded' }); continue; }
    if (!turn || (turn.replyWords?.text ?? turn.replyTranscript) === undefined) { out.push({ id, source: turn?.replyWords?.source ?? "acoustic", verdict: "unmeasured", detail: "no transcribed reply" }); continue; }
    const ok = new RegExp(pattern, "i").test((turn.replyWords?.text ?? turn.replyTranscript)!);
    out.push({ id, source: turn?.replyWords?.source ?? "acoustic", verdict: ok ? "pass" : "fail", detail: `${turn.replyWords?.provenance ?? "local whisper"}; ${ok ? "matched" : "did not match"} /${pattern}/ in ${JSON.stringify((turn.replyWords?.text ?? turn.replyTranscript)!.slice(0, 160))}` });
  }
  for (const [indexText, pattern] of Object.entries(input.forbidWords ?? {})) {
    const turn = turns.find((x) => x.index === Number(indexText));
    const id = `reply-not-words#${indexText}`;
    if (turn?.rigFailure === 'spoke-over-app') { out.push({ id, source: 'rig/infra', verdict: 'unmeasured', detail: 'spoke-over-app: no app transcript; product reply expectation not graded' }); continue; }
    if (!turn || (turn.replyWords?.text ?? turn.replyTranscript) === undefined) { out.push({ id, source: turn?.replyWords?.source ?? "acoustic", verdict: "unmeasured", detail: "no transcribed reply" }); continue; }
    const hit = new RegExp(pattern, "i").exec((turn.replyWords?.text ?? turn.replyTranscript)!);
    out.push({ id, source: turn?.replyWords?.source ?? "acoustic", verdict: hit ? "fail" : "pass", detail: `${turn.replyWords?.provenance ?? "local whisper"}; ${hit ? `said "${hit[0]}" (/${pattern}/)` : `no /${pattern}/`} in ${JSON.stringify((turn.replyWords?.text ?? turn.replyTranscript)!.slice(0, 160))}` });
  }
  if (input.forbiddenWords?.length) {
    const said = turns.filter((x) => x.replyTranscript).map((x) => ({ x, hit: input.forbiddenWords!.find((p) => new RegExp(p, "i").test(x.replyTranscript!)) })).filter((h) => h.hit);
    out.push({ id: "forbidden-words", source: "acoustic", verdict: said.length ? "fail" : turns.some((x) => x.replyTranscript) ? "pass" : "unmeasured",
      detail: said.length ? said.map((h) => `after ${JSON.stringify(h.x.text ?? h.x.kind)}: /${h.hit}/ in ${JSON.stringify(h.x.replyTranscript!.slice(0, 120))}`).join("; ") : `none of ${input.forbiddenWords.map((p) => `/${p}/`).join(", ")}` });
  }

  for (const e of input.uiErrors) out.push({ id: "ui-step", source: "screen", verdict: "fail", detail: e });
  return out;
}
