/**
 * The contract between Mockingbird's core (driver, audio loop, runner,
 * checks) and one app under test. The core knows nothing about any product;
 * everything app-specific (labels, navigation, a backend to start, where its
 * ground-truth records live) is an adapter in src/adapters/<app>/.
 */
import type { PhoneDriver } from "./driver.ts";

export interface UiStepContext {
  driver: PhoneDriver;
  /** Free-form, adapter-defined scenario fields (e.g. which item to open). */
  scenario: Record<string, unknown>;
  log: (line: string) => void;
  /** Calibrated levels for this Mac, device and route, if any (see core/profile.ts). */
  profile?: import("./profile.ts").AudioProfile;
  /** Device volume will be set during the app's speech (--level-during-speech): preflights skip volume. */
  levelDuringSpeech?: boolean;
  /** Wall time the run started (teardown: read app-side records from this run only). */
  runStartedAtWall?: number;
  /** Speak a line to the app through the run's speaker (not scored as a turn). Absent in probes. */
  say?: (text: string) => Promise<void>;
}

export interface UiStepResult extends Record<string, unknown> {
  /** Set by the step that starts a voice session; first-words timing counts from it. */
  voiceStartAtWall?: number;
}

export interface AppStatus {
  /** Status-like labels on screen right now. */
  status: string[];
  /** Every label on screen, for status-label checks. */
  labels: string[];
  /** Text that shows the app's progress (empty when the screen shows none). */
  progress: string;
}

/** What a backend's own records say happened, from this run only. */
export interface BackendEvidence {
  sessions: string[];
  /** What the app said (assembled utterances), with the time each started. */
  assistant: Array<{ text: string; atIso: string; sessionId: string }>;
  /** What the app heard. */
  user: Array<{ text: string; atIso: string; sessionId: string }>;
  /** Wall times the app itself reports its audio output started (trace events). */
  firstOutputWalls?: number[];
  /** Wall-timed events that count as the app advancing its task (state mutations). */
  advanceEvents?: Array<{ atWall: number; what: string }>;
  /** Raw client milestones, for the report. */
  milestones?: string[];
  spendUsd?: number;
  /**
   * Set when this run has no backend records by design (e.g. a device build
   * that talks to a hosted backend the runner cannot read). Backend-only
   * checks then report "n/a" with this reason instead of failing.
   */
  unavailable?: string;
}

export interface Backend {
  /** One line for the log. */
  describe: string;
  /** Live spend for budget enforcement. */
  spendUsd(): number | undefined;
  /** Read this run's records after the run. */
  evidence(): BackendEvidence;
  /** Data the report should copy (e.g. request log), never secrets. */
  reportExtras?(): Record<string, unknown>;
  stop(): Promise<void>;
}

export interface SpendSample {
  spendUsd: number;
  final: boolean;
  stale?: boolean;
  unknownForMs?: number;
}
export interface SpendPolicy {
  stopFraction?: number;
  staleFraction?: number;
  staleAfterMs?: number;
  pollIntervalMs?: number;
}

export interface AppAdapter {
  configureScenario?(scenario: import("../run.ts").Scenario): import("../run.ts").Scenario;
  chimeOptions?: import("./chime.ts").ChimeOptions;
  spendPolicy?: SpendPolicy;
  preRun?(context: UiStepContext): Promise<void>;
  /** Translate opaque app trace data into the rig’s optional scoring evidence. */
  appEvidence?(traceData: unknown): import("./heard.ts").AppEvidence | undefined;
  criticalWords?: ReadonlySet<string>;
  usePolledSpend?(scenario: Record<string, unknown>): boolean;
  syntheticUser?(seed: string): import("./human.ts").SyntheticUser;
  deviceDefaults?: {
    quietTarget?: boolean;
    levelDuringSpeech?: boolean;
    levelOptions?: Pick<import("./levels.ts").LevelControllerOptions, "lowDb" | "highDb" | "maxPresses" | "settleMs">;
  };
  pollPlayback?(context: UiStepContext): Promise<import('./speakerWait.ts').PlaybackReceipt[] | undefined>;
  pollSpend?(context: UiStepContext): Promise<SpendSample | undefined>;
  stopForBudget?(context: UiStepContext): Promise<void>;
  id: string;
  bundleId: string;
  /** UI steps that must succeed or the run stops (setup and voice start). */
  requiredSteps: string[];
  /** Simulator-only preparation (trust a test CA, grant permissions). */
  prepareSimulator?(udid: string): void;
  /** A backend under test started for this run, if the app has one. */
  startBackend?(runDir: string, options: { budgetUsd: number; scenario: Record<string, unknown>; simulator: boolean }): Promise<Backend>;
  /** Apple team for device runs when neither --team nor MOCKINGBIRD_DEVELOPMENT_TEAM is given (e.g. read from the app's own project). */
  developmentTeam?(): string | undefined;
  runUiStep(step: string, context: UiStepContext): Promise<UiStepResult>;
  /**
   * Is the app actually listening right now (not held, paused or muted)? The
   * runner asks after voice starts and before every spoken line that expects
   * an answer, and stops the run when not: talking to a paused session wastes
   * the run and its spend (first device run, 2026-11-11).
   */
  isListening?(driver: PhoneDriver): Promise<{ listening: boolean; reason?: string }>;
  /**
   * Always called at the end of a run, also after a failure or an abort, before
   * the app is terminated: leave nothing behind (an open or held session can
   * block the app's own deploys or the next run).
   * May return `checks` (e.g. from app-side records read after the run); they join the report.
   */
  teardown?(context: UiStepContext): Promise<(Record<string, unknown> & { checks?: import("./assertions.ts").CheckResult[] }) | void>;
  readStatus(driver: PhoneDriver): Promise<AppStatus>;
  /**
   * Optional: pull the backend's own records for this run's time window
   * (e.g. per-turn model timing) after the run, for summary.md. Must be
   * read-only, content-free and never print credentials. Errors never fail a
   * run; the section says why it is missing. Skipped with --no-backend-trace.
   */
  backendTrace?(window: BackendTraceWindow): Promise<BackendTrace | undefined>;
  /** Rebuild backend evidence from a saved run folder (for rescore). */
  /** Explicit read-only archive refresh during rescore; no model calls. */
  refreshReceipts?(report: Record<string, any>): Promise<void>;
  evidenceFromRunDir?(runDir: string, report: Record<string, unknown>): BackendEvidence;
}

export interface BackendTraceWindow {
  /** Wall ms: run start and end (the adapter may widen it for late records). */
  startWall: number; endWall: number;
  runDir: string;
  scenario: Record<string, unknown>;
  simulator: boolean;
  /** Session ids the run's own backend saw, when it has any. */
  sessions: string[];
  log: (line: string) => void;
}

export interface BackendTrace {
  /** Section heading in summary.md. */
  title: string;
  /** Markdown body (a table, a note). */
  markdown: string;
  /** Structured rows for report.json (content-free). */
  data?: unknown;
  /** Optional checks (e.g. a timing bar); they join the report. */
  checks?: import("./assertions.ts").CheckResult[];
}
