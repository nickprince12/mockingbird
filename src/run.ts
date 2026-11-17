import { lineOverlaps } from "./core/speakerWait.ts";
import { applyHeard, heardMarkdown } from './core/heard.ts';
import { quietTarget as shouldQuietTarget, levelDuringSpeech as shouldLevelDuringSpeech } from "./core/runOptions.ts";
/**
 * Mockingbird: a scripted voice user for a real phone app.
 *
 *   mockingbird run --adapter <adapter.ts> --scenario <scenario.json> --device <udid|sim> [options]
 *
 * Starts the app adapter's backend (if any), the Mac audio loop and the
 * XCUITest phone driver; walks the scenario (UI steps on the phone, spoken
 * lines through the Mac speaker, the app's replies through the Mac mic); then
 * writes reports/mockingbird/<run>/report.json + summary.md.
 *
 * Options:
 *   --mic helper|ffmpeg|none   Mac microphone source (default helper: Mockingbird Mic.app)
 *   --budget <usd>             spend ceiling handed to the backend (default 1)
 *   --voice <name>             macOS `say` voice (default Samantha)
 *   --derived-data <dir>       XCUITest build cache (default $TMPDIR/mockingbird-dd)
 *   --team <id>                Apple team for device runs (or MOCKINGBIRD_DEVELOPMENT_TEAM, else the adapter's developmentTeam())
 *   --usb / --poll             device transport: USB via iproxy (default on devices) or Wi-Fi polling
 *   --scenarios-dir <dir>      resolve a bare --scenario id as <dir>/<id>.json
 *   --until <ui-step>          stop before that UI step (a free UI-only run)
 *   --speaker-volume <0-100>   Mac output volume for the run (restored afterwards); default: the profile's
 *   --device-volume <0-1>      the device media-volume target the adapter's preflight enforces; default: the profile's
 *   --route <name>             route the profile is for (default speaker)
 *   --save-profile             store the levels used as this Mac/device/route's profile (lowest reliable + one step)
 *   --level-during-speech      devices: set the device volume with hardware presses, only while the app is
 *                              audibly speaking, toward the lowest clearly detectable level
 *   --speaker-volume-ladder a,b,c  Mac volumes to climb: start at a; when the app does not answer a line,
 *                              go up one rung and replay it once (finds the lowest level the device hears)
 *   --arm <json>               run as one arm of a matrix: {id, label?, scenario?: {launchEnv?, engine?, status?, ...}}
 *   --loop --every <minutes>   unattended loop mode (OFF unless both are given)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AudioLoop, transcribe, transcribeAsync, type Calibration, type MicSource, type SpeechSegment } from "./core/audio.ts";
import { PhoneDriver } from "./core/driver.ts";
import { evaluate, type CheckResult, type StatusExpectation, type Thresholds, type TurnRecord } from "./core/assertions.ts";
import type { Backend, SpendSample, SpendPolicy } from "./core/types.ts";
import { macOutputVolume, profileKey, readProfile, saveProfile, setMacOutputVolume, type AudioProfile } from "./core/profile.ts";
import { DeviceLevelController } from "./core/levels.ts";
import { isFillerOnly } from "./core/filler.ts";
import { detectChimeTrains, type ChimeTrain } from "./core/chime.ts";
import { loadAdapter, micHelperPath } from "./adapters.ts";
import { applyJudge, collectJudgeItems, runJudge, type JudgeResult } from "./core/judge.ts";
import { classifyHealth } from "./core/health.ts";
import type { BackendTrace } from "./core/types.ts";

import { seededRandom, renderPauses, humanMarkdown, type HumanStep, type HumanTurn, type Observation } from "./core/human.ts";
import { randomUUID } from "node:crypto";

/** Shared final grading path: archive classification precedes every asked-based check. */
export function gradeSpeakerTurns(report: { turns: TurnRecord[]; appEvidence?: import("./core/heard.ts").AppEvidence; criticalWords?: ReadonlySet<string> }, steps: Array<{say?: string; ui?: string; await?: string}>, input: Parameters<typeof evaluate>[0], humanTurns: (HumanTurn & {turnIndex: number})[] = [], humanChecks: CheckResult[] = [], checkBehavior?: (turns: HumanTurn[]) => CheckResult[]) {
  applyHeard(report, steps);
  const productHumanTurns = humanTurns.filter(h => !report.turns.find(t => t.index === h.turnIndex)?.rigFailure);
  const productHumanChecks = humanChecks.filter(c => !report.turns.find(t => `human:loop#${t.index}` === c.id)?.rigFailure);
  return [...evaluate({...input, turns: report.turns}), ...productHumanChecks, ...(productHumanTurns.length ? checkBehavior?.(productHumanTurns) ?? [] : [])];
}

/** One measured spend poll; unknown spend never becomes zero. */
export async function pollRunSpend(read: () => Promise<SpendSample | undefined>, budgetUsd: number, stop: () => Promise<void>, capture?: (result: SpendSample | undefined) => void, policy: SpendPolicy = {}) {
  const result = await read();
  capture?.(result);
  const state = result;
  // A short trace outage cannot stop a run. After two minutes only stop if
  // the last known estimate was already near budget (75%).
  if (state && (state.stale ? (state.unknownForMs ?? 0) >= (policy.staleAfterMs ?? 120000) && state.spendUsd >= (policy.staleFraction ?? 0.75) * budgetUsd : state.spendUsd >= (policy.stopFraction ?? 0.85) * budgetUsd)) await stop();
  return result;
}

export async function retrySpeakerLine(audio: Pick<AudioLoop, 'awaitQuiet' | 'say' | 'wallAt'>, turn: TurnRecord, timing: TurnRecord['timing'], quietMs: number, timeoutMs: number, text: string, voice: string, rate: number) {
  if (timing?.mode === 'after-quiet') {
    const waited = await audio.awaitQuiet(quietMs, timeoutMs);
    if (waited.timedOut) turn.notes = [...(turn.notes ?? []), 'speaker-wait-timeout'];
  }
  const played = await audio.say(text, voice, rate);
  turn.spokenAtMs = played.startMs; turn.spokenAtWall = audio.wallAt(played.startMs);
  return played;
}

const toolRoot = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };

export type Step =
  | { ui: string; expectReply?: boolean; timeoutMs?: number; replyWait?: "onset" | "end"; quietMs?: number;
      /** With expectReply: regex the reply should match. */
      expectWords?: string; forbidWords?: string;
      /** With --judge: what the reply should do (expectWords) / must not do (forbidWords), in words. */
      judge?: string; judgeForbid?: string }
  | ({ say: string; expect?: "advance" | "silence"; timeoutMs?: number; atMsAfterPreviousOnset?: number;
      /** Regex the app's reply should match (checked on the local transcript). */
      expectWords?: string;
      /** Regex this line's reply must NOT match (e.g. no instructions before confirmation). */
      forbidWords?: string;
      /** Speak this many ms into the app's speech (the current utterance, or the next one) on purpose: barge-in tests. */
      overlapMs?: number;
      /** Override the scenario's quiet-before-speaking for this line (ms). */
      quietBeforeMs?: number;
      /** With --judge: what the reply should do (expectWords) / must not do (forbidWords), in words; else derived from the regex. */
      judge?: string; judgeForbid?: string } & HumanStep)
  | { await: "first-words"; timeoutMs?: number;
      /** Regex the opening line should match (e.g. it identifies the active task). */
      expectWords?: string; judge?: string };
export interface Scenario extends Record<string, unknown> {
  id: string; description: string; app: string;
  /**
   * Default timing for every line: wait for the app's reply to end plus this
   * much quiet before speaking (ms, default 1500), up to quietTimeoutMs
   * (default 25000), then speak anyway and record it. Speaking into the app's
   * own speech is a different test (a line's overlapMs), not an accident:
   * on a speaker route a line spoken over the app's reply went unheard
   * on some routes.
   */
  quietBeforeMs?: number; quietTimeoutMs?: number;
  /** Phrases the app must never say (regex, case-insensitive). */
  forbiddenWords?: string[];
  /** Not for routine runs (e.g. a barge-in measurement); still runnable by name. */
  manualOnly?: boolean;
  status?: StatusExpectation; thresholds?: Partial<Thresholds>;
  /** Launch environment the adapter passes when it launches the app (an engine or backend switch). */
  launchEnv?: Record<string, string>;
  /** Set by --arm: which arm of an engine matrix this run is. */
  arm?: string;
  steps: Step[];
}

/**
 * One arm of a matrix: the same script, a different configuration. `scenario`
 * is merged over the scenario (shallow; launchEnv merged key by key), so an
 * arm can set the launch environment, the engine and its status expectations.
 */
export interface Arm { id: string; label?: string; scenario?: Partial<Scenario> }
export function applyArm(scenario: Scenario, arm: Arm): Scenario {
  const patch = arm.scenario ?? {};
  return { ...scenario, ...patch, launchEnv: { ...(scenario.launchEnv ?? {}), ...(patch.launchEnv ?? {}) }, steps: patch.steps ?? scenario.steps, arm: arm.id };
}

export function loadScenario(id: string, dir = value("--scenarios-dir") ?? join(toolRoot, "examples/scenarios")): Scenario {
  const path = existsSync(id) ? id : join(dir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`No scenario ${id} (looked for ${path})`);
  const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
  scenario.steps = scenario.steps.map(s => 'intent' in s ? {...s, say: 'say' in s ? s.say : ''} as Step : s);
  return scenario;
}

/** Where reports go: --reports or MOCKINGBIRD_REPORTS, else ./reports/mockingbird. */
function reportsRoot() {
  return resolve(value("--reports") ?? process.env.MOCKINGBIRD_REPORTS ?? "reports/mockingbird");
}

export const spokenLines = (scenario: Scenario) => scenario.steps.flatMap((s) => "say" in s && s.expect !== "silence" ? [s.say] : []);

async function runOnce(): Promise<number> {
  const scenarioId = value("--scenario");
  if (!scenarioId) throw new Error("--scenario <path or id> is required");
  const armJson = value("--arm");
  const arm = armJson ? JSON.parse(armJson) as Arm : undefined;
  const adapter = await loadAdapter(value("--adapter"));
  const loaded = loadScenario(scenarioId);
  const configured = arm ? applyArm(loaded, arm) : loaded;
  const scenario = adapter.configureScenario?.(configured) ?? configured;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(reportsRoot(), `${stamp}-${scenario.app}-${scenario.id}${arm ? `-${arm.id}` : ""}`);
  mkdirSync(runDir, { recursive: true });
  const lines: string[] = [];
  const log = (line: string) => { const row = `${new Date().toISOString().slice(11, 23)} ${line}`; lines.push(row); console.log(row); };
  const budgetUsd = Number(value("--budget", "1"));
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget must be a positive finite USD amount");
  const micChoice = value("--mic", "helper")!;
  const seed = value("--seed") ?? randomUUID();
  const human = adapter.syntheticUser?.(seed);
  if (!human && scenario.steps.some(step => 'intent' in step && step.intent)) throw new Error('Reactive steps require adapter.syntheticUser');
  const random = human ? () => human.random() : seededRandom(seed);
  const observe = (text: string | undefined, source: string): Observation => human?.observe(text, source) ?? { text, source };
  const voice = value("--voice") ?? (flag('--vary-voice') ? ['Samantha','Alex','Daniel'][Math.floor(random()*3)] : 'Samantha');
  const rate = flag('--vary-voice') ? [165,185,205][Math.floor(random()*3)] : 185;
  const continueCounts = new Map<number,number>();
  const humanTurns: (HumanTurn & { turnIndex: number })[] = [];
  const humanChecks: CheckResult[] = [];
  let lastObservation: Observation = {source:'unavailable'};
  log(`synthetic user seed=${seed}, voice=${voice}, rate=${rate}`);

  const driver = new PhoneDriver({ device: value("--device", "sim")!, bundleId: adapter.bundleId,
    derivedDataPath: value("--derived-data", join(tmpdir(), "mockingbird-dd"))!, logFile: join(runDir, "xcodebuild.log"),
    developmentTeam: value("--team", process.env.MOCKINGBIRD_DEVELOPMENT_TEAM) ?? adapter.developmentTeam?.(),
    // Physical devices default to USB (usbmux): Wi-Fi polling needs Local Network
    // permission, which iOS can deny silently. --poll forces the network path.
    transport: flag("--poll") || process.env.MOCKINGBIRD_TRANSPORT === "poll" ? "poll" : flag("--usb") || process.env.MOCKINGBIRD_TRANSPORT === "usb" ? "usb" : "auto" });
  const levelDuringSpeech = shouldLevelDuringSpeech(adapter.deviceDefaults?.levelDuringSpeech ?? false, driver.simulator, process.argv);
  const source: MicSource | undefined = micChoice === "none" ? undefined : micChoice === "ffmpeg" ? { kind: "ffmpeg" } : { kind: "helper", app: micHelperPath() };
  let audio = source ? new AudioLoop(source) : undefined;
  let backend: Backend | undefined;
  // Per-segment transcripts, so filler ("Checking.") can be told from an answer.
  const segmentText = new Map<number, Promise<string | undefined>>();
  let segmentFiles = 0;
  const transcribeSegment = (seg: SpeechSegment) => {
    if (!segmentText.has(seg.startMs)) {
      const file = join(runDir, `segment-${String(++segmentFiles).padStart(3, "0")}.wav`);
      audio!.slice(file, seg.startMs - 150, seg.endMs + 150);
      segmentText.set(seg.startMs, transcribeAsync(file));
    }
    return segmentText.get(seg.startMs)!;
  };
  /**
   * awaitReply, but a reply that so far is only filler ("Checking.", a thud)
   * is not the answer: keep listening, within the same timeout, for speech
   * that is. Otherwise the next line would be spoken over the real answer.
   */
  const awaitUsefulReply = async (sinceMs: number, opts: { timeoutMs: number; quietMs?: number }): Promise<SpeechSegment[]> => {
    const deadline = audio!.nowMs() + opts.timeoutMs;
    let segments = await audio!.awaitReply(sinceMs, opts);
    for (let round = 0; round < 6 && segments.length; round++) {
      const texts = await Promise.all(segments.map(transcribeSegment));
      if (texts.some((t) => t === undefined)) return segments; // no whisper: cannot judge
      if (!texts.every((t) => isFillerOnly(t!) || isNonSpeech(t!))) return segments;
      const left = deadline - audio!.nowMs();
      if (left <= 0) return segments;
      log(`  filler only so far (${texts.map((t) => JSON.stringify(t)).join(", ")}); still listening for the answer`);
      const more = await audio!.awaitReply(segments[segments.length - 1].endMs + 1, { ...opts, timeoutMs: left });
      if (!more.length) return segments;
      segments = [...segments, ...more];
    }
    return segments;
  };
  const key = profileKey(driver.udid, value("--route", "speaker"));
  const stored = readProfile(key);
  const profile: AudioProfile = { ...stored,
    ...(value("--speaker-volume") !== undefined ? { macVolume: Number(value("--speaker-volume")) } : {}),
    ...(value("--device-volume") !== undefined ? { deviceVolume: Number(value("--device-volume")) } : {}),
    route: value("--route", "speaker") };
  const macVolumeBefore = macOutputVolume();
  const ladder = (value("--speaker-volume-ladder") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ladder.length) profile.macVolume = ladder[0];
  let ladderIndex = 0;
  let levels: DeviceLevelController | undefined;

  const turns: TurnRecord[] = [];
  const uiErrors: string[] = [];
  const uiLog: Array<Record<string, unknown>> = [];
  let startMs: number | undefined; let voiceStartWall: number | undefined; let startToFirstWordsMs: number | undefined;
  const statusSamples: string[][] = []; const labelsSeen = new Set<string>();
  let micError: string | undefined;
  let calibration: Calibration | undefined;
  let aborted: string | undefined;
  let polledSpendEstimateUsd: number | undefined;
  let polledSpend: { spendUsd: number; final: boolean } | undefined;
  let spendTimer: ReturnType<typeof setInterval> | undefined;
  let spendPoll: Promise<void> | undefined;
  let monitoring = true;
  const pollSpend = async () => {
    await pollRunSpend(async () => adapter.pollSpend?.({ driver, scenario, log, profile, runStartedAtWall, say: sayLine }), budgetUsd, async () => {
      if (!monitoring || aborted === 'budget-stop') return;
      aborted = 'budget-stop'; log('budget-stop: reported spend reached the configured cutoff');
      await adapter.stopForBudget?.({ driver, scenario, log, profile, runStartedAtWall, say: sayLine });
    }, result => { if (result) { polledSpend = result; if (!result.final) polledSpendEstimateUsd = result.spendUsd; } }, adapter.spendPolicy);
  };
  /** Checks an adapter adds at teardown (e.g. from app-side records read after the run). */
  const teardownChecks: CheckResult[] = [];
  let chimeTrains: ChimeTrain[] = [];
  const runStartedAtWall = Date.now();
  const quietGap = async (ms: number) => new Promise((r) => setTimeout(r, ms));
  let previousOnsetMs: number | undefined;
  /** A line for an adapter step or teardown (e.g. cancelling clocks by voice): played, not scored as a turn. */
  const sayLine = async (text: string) => {
    if (aborted === 'budget-stop') return;
    log(`  (adapter) says ${JSON.stringify(text)}`);
    if (audio) await audio.say(text, voice);
    else await new AudioLoop({ kind: "file", path: "/dev/null" }).say(text, voice).catch(() => undefined);
  };
  const sample = async () => { const s = await adapter.readStatus(driver); if (voiceStartWall !== undefined) statusSamples.push(s.status); s.labels.forEach((l) => labelsSeen.add(l)); return s; };

  let preRunPassed = false;
  try {
    log(`scenario ${scenario.app}/${scenario.id} on ${driver.udid}${driver.simulator ? " (Simulator)" : " (device)"}; budget $${budgetUsd}`);
    if (driver.simulator) adapter.prepareSimulator?.(driver.udid);
    if (profile.macVolume !== undefined) setMacOutputVolume(profile.macVolume);
    log(`levels: Mac output ${macOutputVolume()} (was ${macVolumeBefore})${profile.deviceVolume !== undefined ? `, device target ${Math.round(profile.deviceVolume * 100)}%` : ""}${stored ? ` [profile ${key}]` : " [no stored profile]"}`);
    if (adapter.startBackend) { backend = await adapter.startBackend(runDir, { budgetUsd, scenario, simulator: driver.simulator }); log(`backend: ${backend.describe}`); }
    if (audio) {
      try {
        await audio.start(); await quietGap(1500);
        log(`mic: ${micChoice}, floor ${audio.vad.noiseFloorDb.toFixed(1)} dBFS`);
        noiseFloorForMargins = audio.vad.noiseFloorDb;
        calibration = await audio.calibrate();
        log(`calibration: ${calibration.valid ? `offset ${calibration.offsetMs} ms, spread ${calibration.spreadMs} ms` : `INVALID (${calibration.reason}); latency checks will not pass`} [${calibration.offsets.join(", ")}]`);
      }
      catch (error) { micError = (error as Error).message; log(`mic unavailable: ${micError}`); await audio.stop(); audio = undefined; }
    }
    await driver.start();
    log(`driver connected: ${JSON.stringify(driver.info)}`);
    await adapter.preRun?.({ driver, scenario, log });
    preRunPassed = true;

    const currentObservation = async (turn: TurnRecord): Promise<Observation> => {
      if (adapter.backendTrace && !flag('--no-backend-trace')) {
        try {
          const trace = await withTimeout(adapter.backendTrace({startWall: runStartedAtWall, endWall: Date.now(), runDir, scenario, simulator: driver.simulator, sessions: backend?.evidence().sessions ?? [], log}), 15000, 'reactive transcript');
          const r = {turns, appEvidence: adapter.appEvidence?.(trace?.data), criticalWords: adapter.criticalWords}; applyHeard(r, scenario.steps);
          const reply = (turn as any).replyWords;
          if(reply?.source==='backend' && reply.text) return observe(reply.text,reply.provenance);
        } catch { log('reactive app transcript unavailable; using local whisper'); }
      }
      // Early speech requires submitted text. Without it, wait for acoustic completion
      // rather than inventing a response to an unfinished/unknown instruction.
      if(audio && turn.replyStartMs!==undefined && turn.replyEndMs===undefined) applyReply(turn,await awaitUsefulReply(turn.cueEndMs,{timeoutMs:20000}));
      if(audio && turn.replyStartMs!==undefined && turn.replyEndMs!==undefined) {
        const file=join(runDir, `reactive-${turn.index}.wav`);
        audio.slice(file,turn.replyStartMs,turn.replyEndMs);
        turn.replyTranscript=await transcribeAsync(file);
      }
      return observe(turn.replyTranscript,'local whisper');
    };
    const captureReply = async (turn: TurnRecord, since: number, timeoutMs: number) => {
      if(flag('--early-speech')) {
        turn.replyStartMs=await audio!.awaitOnset(since,timeoutMs);
      } else applyReply(turn,await awaitUsefulReply(since,{timeoutMs}));
    };
    if (audio && adapter.pollPlayback) audio.playbackReceipts = () => adapter.pollPlayback!({ driver, scenario, runStartedAtWall, log, profile, say: sayLine });
    if (adapter.pollSpend) spendTimer = setInterval(() => {
      if (!spendPoll) spendPoll = pollSpend().catch(() => log('WARNING: spend unknown')).finally(() => { spendPoll = undefined; });
    }, adapter.spendPolicy?.pollIntervalMs ?? 5000);
    let index = 0;
    for (const step of scenario.steps) {
      index++;
      if (aborted === 'budget-stop') break;
      if (backend && (backend.spendUsd() ?? -1) >= budgetUsd) { aborted = `spend $${(backend.spendUsd() ?? 0).toFixed(3)} passed the $${budgetUsd} budget`; break; }
      if ("ui" in step && step.ui === value("--until")) { log(`stopping before ${step.ui} (--until)`); break; }
      if ("ui" in step) {
        log(`ui ${step.ui}`);
        try {
          const result = await adapter.runUiStep(step.ui, { driver, scenario, log, profile, levelDuringSpeech, say: sayLine });
          uiLog.push({ step: step.ui, ...result });
          if (result.voiceStartAtWall !== undefined) {
            voiceStartWall = result.voiceStartAtWall;
            startMs = audio ? audio.micMsAt(voiceStartWall) : undefined;
            if (levelDuringSpeech && audio && !driver.simulator && !levels) {
              levels = new DeviceLevelController(driver, audio, { ...adapter.deviceDefaults?.levelOptions, quietTarget: shouldQuietTarget(adapter.deviceDefaults?.quietTarget ?? false, driver.simulator, process.argv), log, previous: profile.callLevel,
                onSettled: (callLevel) => { profile.callLevel = callLevel; saveProfile(key, { callLevel }); } });
              levels.start();
              log("  device level: pressing only while the app is audibly speaking");
            }
          }
          if (step.expectReply) {
            const cue = audio ? audio.micMsAt(Date.now()) : 0;
            const turn: TurnRecord = { index, kind: "resume", text: step.ui, cueEndMs: cue, cueEndWall: Date.now(), extraSegments: 0 };
            if (audio && step.replyWait === "onset") {
              // Return at the reply's onset so the next line can be timed against it (overlap tests).
              const onset = await audio.awaitOnset(cue, step.timeoutMs ?? 20000);
              if (onset !== undefined) { turn.replyStartMs = onset; previousOnsetMs = onset; }
            } else if (audio) {
              applyReply(turn, await awaitUsefulReply(cue, { timeoutMs: step.timeoutMs ?? 20000, quietMs: step.quietMs }));
              previousOnsetMs = turn.replyStartMs;
            } else await quietGap(12000);
            turns.push(turn); log(`  reply after ${step.ui}: ${turn.replyStartMs !== undefined ? `${((turn.replyStartMs - cue) / 1000).toFixed(1)} s` : "NONE"}`);
          }
        } catch (error) {
          const message = `${step.ui}: ${(error as Error).message}`;
          uiErrors.push(message); log(`  FAILED ${message}`);
          await driver.screenshot(join(runDir, `fail-${index}-${step.ui}.png`));
          if (adapter.requiredSteps.includes(step.ui)) { aborted = message; break; }
        }
        continue;
      }
      if ("await" in step) {
        const since = startMs ?? audio?.nowMs() ?? 0;
        const turn: TurnRecord = { index, kind: "greeting", cueEndMs: since, cueEndWall: voiceStartWall, extraSegments: 0 };
        if (audio) {
          await captureReply(turn,since,step.timeoutMs??20000);
          if (turn.replyStartMs !== undefined) startToFirstWordsMs = turn.replyStartMs - since;
        } else await quietGap(15000);
        turns.push(turn);
        log(`  first words ${startToFirstWordsMs !== undefined ? `${(startToFirstWordsMs / 1000).toFixed(1)} s after voice start` : "not heard"}`);
        await sample();
        if(scenario.steps.some(s=>'intent' in s)) lastObservation=await currentObservation(turn);
        continue;
      }
      const hs = step as typeof step & {_attempt?:number; _repeated?:number; _previous?:string; _continues?:number};
      const before = {...lastObservation, progress: step.intent ? (await sample()).progress : undefined};
      if (human && step.intent) step.say = human.speak(step, before, Boolean(hs._attempt), hs._previous);
      if (aborted === 'budget-stop') break;
      if (adapter.isListening && step.expect !== "silence" && voiceStartWall !== undefined) {
        const state: { listening: boolean; reason?: string } = await adapter.isListening(driver).catch(() => ({ listening: true }));
        if (aborted === 'budget-stop') break;
        if (!state.listening) { aborted = `the app is not listening (${state.reason ?? "unknown"}) before "${step.say}"; stopped rather than talking to it`; log(`  STOP: ${aborted}`); await driver.screenshot(join(runDir, `not-listening-${index}.png`)); break; }
      }
      const turn: TurnRecord = { index, kind: "say", text: step.say, expect: step.expect, cueEndMs: 0, extraSegments: 0 };
      if (step.expect === "advance") turn.progressBefore = (await sample()).progress;
      let timing: TurnRecord["timing"];
      if (audio && step.atMsAfterPreviousOnset !== undefined) {
        if (previousOnsetMs === undefined) { aborted = `"${step.say}" is timed against the previous reply's onset, but none was heard`; log(`  STOP: ${aborted}`); break; }
        await audio.waitUntil(previousOnsetMs + step.atMsAfterPreviousOnset);
        timing = { mode: "after-onset", overlapMs: step.atMsAfterPreviousOnset };
        log(`  playing ${step.atMsAfterPreviousOnset} ms after the previous reply's onset`);
      } else if (audio && step.overlapMs !== undefined) {
        // Barge-in on purpose: into the app's current utterance, or its next one.
        const onset = audio.vad.openSinceMs ?? await audio.awaitOnset(audio.nowMs(), scenario.quietTimeoutMs ?? 60000);
        if (onset === undefined) { aborted = `"${step.say}" should overlap the app's speech, but the app did not speak`; log(`  STOP: ${aborted}`); break; }
        await audio.waitUntil(onset + step.overlapMs);
        timing = { mode: "overlap", overlapMs: step.overlapMs };
        log(`  barge-in: playing ${step.overlapMs} ms into the app's speech`);
      } else if (audio && flag('--early-speech') && audio.vad.openSinceMs!==undefined) {
        const earlyMs=300+Math.floor(random()*701);
        const estimatedDuration=Math.max(1000,(before.text?.split(/\s+/).length??9)*60000/170);
        await audio.waitUntil(audio.vad.openSinceMs+Math.max(0,estimatedDuration-earlyMs));
        timing={mode:'overlap',overlapMs:Math.max(0,estimatedDuration-earlyMs)};
        log(`experimental early speech: ${earlyMs} ms before estimated end (actual overlap in timeline)`);
      } else if (audio) {
        const quietMs = step.quietBeforeMs ?? scenario.quietBeforeMs ?? 1500;
        const waited = await audio.awaitQuiet(quietMs, scenario.quietTimeoutMs ?? 25000);
        timing = { mode: "after-quiet", quietMs, waitedMs: waited.waitedMs, timedOut: waited.timedOut };
        if (waited.timedOut) { turn.notes = ["speaker-wait-timeout"]; log(`  the app was still talking after ${Math.round(waited.waitedMs / 1000)} s; speaking anyway (speaker-wait-timeout)`); }
      }
      if (audio) {
        if (aborted === 'budget-stop') break;
        const played = await audio.say(renderPauses(step.say, flag('--mid-pauses')), voice, rate);
        turn.spokenAtMs = played.startMs; turn.spokenAtWall = audio.wallAt(played.startMs); turn.timing = timing;
        // The line is audible until playback end + the calibrated offset.
        turn.cueEndMs = played.endMs + (calibration?.valid ? calibration.offsetMs ?? 0 : 0); turn.cueEndWall = Date.now();
        await captureReply(turn,played.endMs,step.timeoutMs??20000);
        // Mac ladder: no answer to a line the app should answer -> one rung up, replay once.
        if (turn.replyStartMs === undefined && step.expect !== "silence" && ladderIndex + 1 < ladder.length) {
          ladderIndex++; profile.macVolume = ladder[ladderIndex]; setMacOutputVolume(profile.macVolume);
          log(`  no reply: Mac volume up to ${profile.macVolume} (ladder), replaying the line`);
          if (aborted === 'budget-stop') break;
          const again = await retrySpeakerLine(audio, turn, timing, step.quietBeforeMs ?? scenario.quietBeforeMs ?? 1500, scenario.quietTimeoutMs ?? 25000, renderPauses(step.say, flag('--mid-pauses')), voice, rate);
          turn.cueEndMs = again.endMs + (calibration?.valid ? calibration.offsetMs ?? 0 : 0); turn.cueEndWall = Date.now();
          applyReply(turn, await awaitUsefulReply(again.endMs, { timeoutMs: step.timeoutMs ?? 20000 }));
        }
      } else {
        // No mic: the line must still reach the phone.
        await new AudioLoop({ kind: "file", path: "/dev/null" }).say(renderPauses(step.say, flag('--mid-pauses')), voice, rate).catch(() => undefined);
        turn.cueEndWall = Date.now();
        await quietGap(step.timeoutMs ?? 12000);
      }
      if (step.expect === "advance") { await quietGap(1000); turn.progressAfter = (await sample()).progress; } else await sample();
      turns.push(turn);
      if (human && step.intent) {
        lastObservation={...await currentObservation(turn),progress:(await sample()).progress};
        const attempt=(hs._attempt??0)+1;
        const repeated=before.instruction && before.instruction===lastObservation.instruction ? (hs._repeated??0)+1 : 0;
        const names = human.names(scenario);
        const decision=human.decide(step,before,lastObservation,attempt,repeated,{history:humanTurns.map(t=>t.before).filter(o=>o.instruction).slice(-3),names,continues:step.stepGroup===undefined?(hs._continues??0):(continueCounts.get(step.stepGroup)??0)});
        if(decision==='continue' && step.stepGroup!==undefined)continueCounts.set(step.stepGroup,(continueCounts.get(step.stepGroup)??0)+1);
        humanTurns.push({names,turnIndex:turn.index,before,after:lastObservation,intent:step.intent.name,stepGroup:step.stepGroup,completed:human.completesStep(step,decision)});
        if(decision==='retry' || decision==='continue') scenario.steps.splice(index,0,{...step,say:'',_attempt:decision==='continue'?0:attempt,_repeated:decision==='continue'?0:repeated,_previous:step.say,_continues:(hs._continues??0)+(decision==='continue'?1:0)} as Step);
        if(decision==='fail') {humanChecks.push({id:`human:loop#${index}`,verdict:'fail',source:'reactive synthetic user',detail:`Consecutive stalled-turn or 25-continue runaway cap reached after ${attempt} stalled turns; last evidence: ${lastObservation.source}`}); aborted='reactive user failed to advance'; break;}
      }
      log(`  "${step.say}" -> ${turn.replyStartMs !== undefined ? `reply after ${((turn.replyStartMs - turn.cueEndMs) / 1000).toFixed(1)} s, ${((turn.replyEndMs! - turn.replyStartMs) / 1000).toFixed(1)} s long` : audio ? "no reply" : "(no mic)"}`);
    }
    await driver.screenshot(join(runDir, "final.png"));
  } catch (error) {
    if (aborted !== 'budget-stop') aborted = (error as Error).message; log(`ABORTED: ${aborted}`);
  } finally {
    monitoring = false;
    clearInterval(spendTimer);
    await spendPoll;
    levels?.stop();
    if (preRunPassed && adapter.teardown && driver.info) {
      try { const done = await adapter.teardown({ driver, scenario, log, profile, runStartedAtWall, say: sayLine }); const { checks: extra, ...rest } = (done ?? {}) as { checks?: CheckResult[] }; if (Array.isArray(extra)) teardownChecks.push(...extra); uiLog.push({ step: "teardown", ...rest }); log("teardown: done"); }
      catch (error) { const message = `teardown: ${(error as Error).message}`; uiErrors.push(message); log(`  FAILED ${message}`); await driver.screenshot(join(runDir, "fail-teardown.png")).catch(() => undefined); }
    }
    if (driver.info) await driver.run("terminate", {}, { allowFail: true }).catch(() => undefined);
    await driver.stop().catch(() => undefined);
    await audio?.stop();
    await quietGap(5000); // finalize receipts and respect the spend poll interval
    await backend?.stop();
    if (adapter.pollSpend) await pollSpend().catch(() => log("WARNING: spend unknown"));
    // Never leave the user's Mac changed.
    try { setMacOutputVolume(macVolumeBefore); } catch { /* best effort */ }
  }

  if (audio) {
    // Unprompted speech: segments after a reply ended and before the next cue.
    // A periodic alarm chime is counted apart (alarm-ringing), never as speech.
    const segments = audio.vad.segments.filter((s) => !s.overlapsPlayback);
    const chime = detectChimeTrains(audio.vad.segments, adapter.chimeOptions);
    for (const turn of turns) if (turn.kind === "say" && turn.spokenAtMs !== undefined) {
      turn.overlappedAppSpeech = lineOverlaps(turn.spokenAtMs, turn.cueEndMs, audio.vad.segments.filter(s => !chime.isChime(s)));
    }
    chimeTrains = chime.trains;
    if (chimeTrains.length) log(`alarm chime heard: ${chimeTrains.map((t) => `${t.pulses} pulses / ${t.periodMs} ms`).join(", ")}`);
    const cues = audio.playbacks.map((p) => p.startMs);
    for(const turn of turns) if(turn.replyStartMs!==undefined && turn.replyEndMs===undefined) {
      const nextCue=cues.find(c=>c>turn.replyStartMs!)??audio.nowMs();
      const heard=segments.filter(s=>s.startMs>=turn.replyStartMs!-200&&s.startMs<nextCue);
      if(heard.length) applyReply(turn,heard);
      else turn.replyStartMs=undefined;
    }
    for (const turn of turns) {
      if (turn.replyEndMs === undefined || turn.kind === "resume") continue;
      const nextCue = cues.find((c) => c > turn.replyEndMs!) ?? Number.POSITIVE_INFINITY;
      const after = segments.filter((s) => s.startMs > turn.replyEndMs! + 200 && s.startMs < nextCue);
      turn.chimeSegments = after.filter((s) => chime.isChime(s)).length;
      turn.extraSegments = after.length - turn.chimeSegments;
    }
    // Chime pulses inside a reply are not the reply.
    for (const turn of turns) for (const seg of turn.segments ?? []) if (chime.isChime(seg)) seg.chime = true;
    audio.writeAll(join(runDir, "mic.wav"));
    for (const turn of turns) {
      if (turn.replyStartMs === undefined) continue;
      const file = join(runDir, `reply-${String(turn.index).padStart(2, "0")}.wav`);
      audio.slice(file, turn.replyStartMs - 150, turn.replyEndMs! + 150);
      turn.replyTranscript = transcribe(file);
      // Energy is not speech: on the first device run every early "reply" was a
      // thud or typing. When whisper says the slice is not speech, it is no reply.
      if (turn.replyTranscript !== undefined && isNonSpeech(turn.replyTranscript)) {
        turn.replyNonSpeech = true;
        turn.replyStartMs = undefined; turn.replyEndMs = undefined;
        if (turn.kind === "greeting") startToFirstWordsMs = undefined;
      }
    }
    // Useful speech: each segment's own transcript; filler-only segments do not count.
    for (const turn of turns) {
      if (!turn.segments?.length) continue;
      if (turn.replyStartMs === undefined) { turn.segments = undefined; continue; }
      for (const seg of turn.segments) {
        const text = await transcribeSegment({ startMs: seg.startMs, endMs: seg.endMs } as SpeechSegment);
        seg.transcript = text;
        if (text === undefined) continue;
        seg.nonSpeech = isNonSpeech(text);
        seg.filler = !seg.nonSpeech && isFillerOnly(text);
      }
      if (turn.segments.every((g) => g.transcript !== undefined)) {
        turn.usefulStartMs = turn.segments.find((g) => !g.filler && !g.nonSpeech && !g.chime)?.startMs;
        turn.fillerSegments = turn.segments.filter((g) => g.filler).length;
      }
    }
  }

  const evidence = backend?.evidence();
  const checks: CheckResult[] = [];
  // The backend's own records for this run's window (adapter hook; optional, never fails the run).
  let trace: BackendTrace | undefined; let traceError: string | undefined;
  if (adapter.backendTrace && !flag("--no-backend-trace")) {
    try {
      trace = await withTimeout(adapter.backendTrace({ startWall: runStartedAtWall, endWall: Date.now(), runDir, scenario: { ...scenario, mockingbirdRunContext: { route: profile.route, outputs: uiLog.filter(u => Array.isArray(u.outputs)).at(-1)?.outputs, deviceId: driver.udid, spokeOver: turns.some(t => t.timing?.mode === "overlap" || t.timing?.mode === "after-onset"), abortReason: aborted } }, simulator: driver.simulator, sessions: evidence?.sessions ?? [], log }), 120000, "backend trace");
      if (trace?.checks?.length) checks.push(...trace.checks);
    } catch (error) { traceError = (error as Error).message; log(`backend trace unavailable: ${traceError}`); }
  }
  const appEvidence = adapter.appEvidence?.(trace?.data);
  const heardReport = { turns, appEvidence, criticalWords: adapter.criticalWords };
  checks.push(...gradeSpeakerTurns(heardReport, scenario.steps, { turns, micAvailable: Boolean(audio), startToFirstWordsMs, voiceStartWall, backend: evidence,
    spokenLines: spokenLines(scenario), labelsSeen: labelsSeen.size ? [...labelsSeen] : undefined, status: scenario.status, thresholds: scenario.thresholds, calibration, uiErrors,
    statusSamples, forbiddenWords: scenario.forbiddenWords, chimeTrains,
    expectWords: Object.fromEntries(scenario.steps.flatMap((s, i) => s.expectWords ? [[i + 1, s.expectWords]] : [])),
    forbidWords: Object.fromEntries(scenario.steps.flatMap((s, i) => "forbidWords" in s && s.forbidWords ? [[i + 1, s.forbidWords]] : []))  }, humanTurns, humanChecks, human ? rows => human.checks(rows, scenario, trace?.data) : undefined), ...teardownChecks);
  if (aborted && !(aborted === 'reactive user failed to advance' && turns.at(-1)?.rigFailure)) checks.push({ id: "run-completed", source: "mockingbird", verdict: "fail", detail: aborted });
  if (micError) checks.push({ id: "mac-microphone", source: "mockingbird", verdict: "unmeasured", detail: micError });
  // Optional model judge over every expectation (off unless --judge or MOCKINGBIRD_JUDGE=1).
  let judge: JudgeResult | undefined;
  if (flag("--judge") || process.env.MOCKINGBIRD_JUDGE === "1") {
    const items = collectJudgeItems({ steps: scenario.steps as never, turns, checks, screenChecks: scenario.screenChecks as never });
    judge = await runJudge(items, { scenario: scenario.id, description: scenario.description });
    const judged = applyJudge(checks, items, judge);
    checks.splice(0, checks.length, ...judged);
    log(`model judge: ${judge.error ?? `${judge.verdicts.length}/${items.length} graded`}, $${judge.costUsd.toFixed(4)}`);
  }
  let verdict = checks.some((c) => c.verdict === "fail") ? "FAIL" : checks.some((c) => c.verdict === "unmeasured") ? "INCOMPLETE" : "PASS";
  if (aborted === 'budget-stop') verdict = 'INCOMPLETE';
  if (flag("--save-profile")) {
    // A call route cannot be calibrated from the reported media slider.
    saveProfile(key, { macVolume: profile.macVolume, deviceVolume: profile.deviceVolume, route: profile.route, note: `saved after a ${verdict} run` });
    console.log(`profile saved: ${key}`);
  }

  const report = {
    clientBuildId: scenario.clientBuildId, expectedClientBuildId: scenario.expectedClientBuildId,
    verdict, app: scenario.app, scenario: scenario.id, arm: arm ? { id: arm.id, label: arm.label, launchEnv: scenario.launchEnv } : undefined, device: driver.udid, simulator: driver.simulator, startedAt: stamp,
    micAvailable: Boolean(audio), calibration, levels: { profileKey: key, macVolume: profile.macVolume, macVolumeRestoredTo: macVolumeBefore, deviceVolumeTarget: profile.deviceVolume, deviceLevelController: levels?.result }, voiceStartWall, startToFirstWordsMs, spendUsd: adapter.usePolledSpend?.(scenario) ? polledSpend?.spendUsd : evidence?.spendUsd, polledSpend, polledSpendEstimateUsd, stopReason: aborted === 'budget-stop' ? aborted : undefined, budgetUsd,
    human: {seed,voice,rate,coverage:human?.coverage ?? {},bankSizes:human?.bankSizes ?? {},turns:humanTurns},
    checks, turns, heardAs: (heardReport as any).heardAs, ui: uiLog,
    health: classifyHealth({ checks, startToFirstWordsMs, runLog: lines.join("\n") }),
    judge: judge ? { model: judge.model, costUsd: judge.costUsd, usage: judge.usage, items: judge.items, verdicts: judge.verdicts, error: judge.error } : undefined,
    backendTrace: trace ? { title: trace.title, data: trace.data } : traceError ? { error: traceError } : undefined,
    // One timeline on the mic clock (ms since the recorder started), with wall times:
    // every robot playback and every detected speech segment (the app, or noise).
    timeline: audio ? {
      playbacks: audio.playbacks.map((p) => ({ text: p.text, startMs: p.startMs, endMs: p.endMs, startWall: audio!.wallAt(p.startMs) })),
      speech: audio.vad.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, peakDb: s.peakDb, overlapsPlayback: s.overlapsPlayback, startWall: audio!.wallAt(s.startMs) })),
      noiseFloorDb: audio.vad.noiseFloorDb,
      chimeTrains,
    } : undefined, statusSamples, labelsSeen: [...labelsSeen], driverInfo: driver.info, driverCommands: driver.transcript,
    backend: { sessions: evidence?.sessions ?? [], assistant: evidence?.assistant ?? [], user: evidence?.user ?? [], ...(backend?.reportExtras?.() ?? {}) },
    provenance: { mockingbird: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: toolRoot, encoding: "utf8" }).trim(); } catch { return undefined; } })(),
      appTree: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; } })(),
      note: "Backend records come from this run's own backend data only; no other session is read." },
  };
  const { captureDiagnosis } = await import("./core/captureDiagnosis.ts");
  checks.push(...captureDiagnosis({ ...report, appEvidence }));
  if (checks.some(c => c.id === 'played-not-heard')) { verdict = "FAIL"; report.verdict = verdict; }
  report.health = classifyHealth({ checks, startToFirstWordsMs, runLog: lines.join("\n") });
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, "run.log"), lines.join("\n") + "\n");
  writeFileSync(join(runDir, "summary.md"), summary(report, checks, turns, trace, traceError));
  console.log(`\n${verdict}  ${join(runDir, "summary.md")}`);
  return verdict === "PASS" ? 0 : 1;
}

/** whisper's markers for non-speech: "(thud)", "[typing]", "[BLANK_AUDIO]", or nothing at all. */
export function isNonSpeech(transcript: string): boolean {
  const text = transcript.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  // whisper's well-known hallucinations on near-silence (device run, 2026-11-11: a lone "you").
  return text.length === 0 || /^(you|thank you|thanks for watching|thank you for watching|bye)$/.test(text);
}

let noiseFloorForMargins = -60;
function applyReply(turn: TurnRecord, segs: SpeechSegment[]) {
  if (!segs.length) return;
  turn.replyStartMs = segs[0].startMs;
  turn.replyEndMs = segs[segs.length - 1].endMs;
  turn.segments = segs.map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
  turn.replyPeakDb = Math.max(...segs.map((s) => s.peakDb));
  turn.replyMarginDb = Math.round((turn.replyPeakDb - noiseFloorForMargins) * 10) / 10;
}

export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} took over ${Math.round(ms / 1000)} s`)), ms); })]); }
  finally { clearTimeout(timer); }
}

export function summary(report: any, checks: ReturnType<typeof evaluate>, turns: TurnRecord[], trace?: BackendTrace, traceError?: string): string {
  if (!report.heardAs) { const r = {...report, turns}; applyHeard(r); report.heardAs = r.heardAs; }
  const icon = (v: string) => ({ pass: "PASS", fail: "FAIL", warn: "WARN", unmeasured: "----", "n/a": "n/a" } as Record<string, string>)[v] ?? v;
  const rows = checks.map((c) => `| ${icon(c.verdict)} | ${c.id} | ${c.source} | ${c.detail.replace(/\|/g, "/")} |`).join("\n");
  const turnRows = turns.map((t) => `| ${t.index} | ${t.kind === "say" ? JSON.stringify(t.text) : t.kind} | ${t.replyStartMs !== undefined ? ((t.replyStartMs - t.cueEndMs) / 1000).toFixed(1) + " s" : "—"} | ${(t.replyTranscript ?? "").slice(0, 120).replace(/\|/g, "/")} | ${t.kind === "say" ? t.overlappedAppSpeech === undefined ? "unmeasured" : String(t.overlappedAppSpeech) : ""} | ${(t.notes ?? []).join(", ")}${t.rigFailure ? `; ${t.rigFailure}` : ""} |`).join("\n");
  const said = (report.backend.assistant as Array<{ text: string }>).map((a) => `- ${a.text}`).join("\n");
  return `# Mockingbird: ${report.app}/${report.scenario}${report.arm ? ` [${report.arm.id}]` : ""} — ${report.verdict}

${report.simulator ? "Simulator" : "Device"} ${report.device}, ${report.startedAt}.
Installed clientBuildId: ${report.clientBuildId ?? "unavailable"}; expected: ${report.expectedClientBuildId ?? "unavailable"}.
Spend ${report.spendUsd === undefined ? 'unknown' : `$${report.spendUsd.toFixed(3)}`} of $${report.budgetUsd}.${report.polledSpend ? (report.polledSpend.final ? ' Final reported spend.' : ' Conservative spend estimate; final spend unknown.') : ''}${report.polledSpendEstimateUsd === undefined ? '' : ` Last mid-run estimate $${report.polledSpendEstimateUsd.toFixed(3)}; final spend ${report.polledSpend?.final ? `$${report.polledSpend.spendUsd.toFixed(3)}` : 'unknown'}.`}${report.judge ? ` Model judge (${report.judge.model}): $${report.judge.costUsd.toFixed(4)}${report.judge.error ? ` (${report.judge.error})` : ""}.` : ""}
Health: ${report.health ? `${report.health.health}${report.health.reasons.length ? ` (${report.health.reasons.join("; ")})` : ""}` : "-"}.

| | check | source | detail |
|---|---|---|---|
${rows}

${humanMarkdown(report.human)}
${heardMarkdown(report.heardAs)}

## Turns (acoustic)

| # | cue | reply onset | heard (local whisper) | overlapped app | rig notes |
|---|---|---|---|---|---|
${turnRows}

## What the app said (backend records)

${said || "(none)"}
${trace ? `\n## ${trace.title}\n\n${trace.markdown}\n` : traceError ? `\n## Backend trace\n\nUnavailable: ${traceError}\n` : ""}
Evidence: mic.wav, reply-*.wav, report.json, run.log, xcodebuild.log, backend/ in this folder.
`;
}

export async function main() {
  if (flag("--loop")) {
    const every = Number(value("--every"));
    if (!Number.isFinite(every) || every < 5) throw new Error("--loop needs --every <minutes> (at least 5). Loop mode is off unless both are given.");
    for (;;) { await runOnce().catch((error) => console.error(error)); await new Promise((r) => setTimeout(r, every * 60000)); }
  }
  process.exitCode = await runOnce();
}

// Only when run as the entry point, so other modules can import helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
