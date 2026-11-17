import { receiptPlaybackOngoing } from './speakerWait.ts';
import { waitForSpeaker } from "./speakerWait.ts";
/**
 * Mockingbird's mouth and ears on the Mac.
 *
 * Mouth: macOS `say` renders each spoken line to a WAV once (cached by text and
 * voice), `afplay` plays it through the Mac's default output. No paid TTS.
 *
 * Ears: a continuous 16 kHz mono s16le stream from the Mac's default input,
 * cut into 20 ms frames, fed to an energy VAD with an adaptive noise floor.
 * Every frame is also kept, so the whole run is written out as one WAV and any
 * reply can be sliced out for local transcription.
 *
 * The mic hears Mockingbird's own voice too. Frames that fall inside a playback
 * window (plus a short tail for room decay) are marked as playback and never count
 * as the phone speaking; that is bookkeeping about our own output, not echo
 * cancellation of the phone's.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

export const sampleRate = 16000;
const frameSamples = 320; // 20 ms
const frameMs = 20;

export interface VadOptions {
  /** dB above the noise floor that counts as speech onset. */
  onsetDb: number;
  /** Speech must persist this long to open a segment. */
  minSpeechMs: number;
  /** Silence this long closes a segment (assistants pause between sentences). */
  hangoverMs: number;
  /** Ignore the mic this long after Mockingbird's own playback ends. */
  playbackTailMs: number;
  /** Absolute floor in dBFS below which nothing is speech. */
  absoluteFloorDb: number;
  /** Real (non-silent) audio needed before any segment may open. */
  warmupMs: number;
}

export const defaultVad: VadOptions = { onsetDb: 12, minSpeechMs: 160, hangoverMs: 900, playbackTailMs: 350, absoluteFloorDb: -85, warmupMs: 1000 };

export interface SpeechSegment {
  /** ms since the recorder started. */
  startMs: number;
  endMs: number;
  peakDb: number;
  /** True when any part overlapped Mockingbird's own playback (a talk-over or our echo). */
  overlapsPlayback: boolean;
}

export interface PlaybackWindow { text: string; startMs: number; endMs: number; file: string }

export type MicSource = { kind: "helper"; app: string } | { kind: "ffmpeg" } | { kind: "file"; path: string };

/** dBFS of one frame. */
function frameDb(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

/**
 * Pure VAD over a frame stream, separated from I/O so it can be unit-tested
 * against recorded WAVs.
 */
export class EnergyVad {
  private floorDb = -60;
  /** Recent quiet-ish frame levels (3 s); 20th percentile during warmup, then median; can rise or fall. */
  private recent: number[] = [];
  private realMs = 0;
  private leadIn: Array<{ db: number; atMs: number }> = [];
  private speechRun = 0;
  private silenceRun = 0;
  private open?: { startMs: number; peakDb: number; overlapsPlayback: boolean };
  readonly segments: SpeechSegment[] = [];
  constructor(private readonly options: VadOptions = defaultVad) {}

  get noiseFloorDb() { return this.floorDb; }
  /** Start (mic ms) of the speech segment in progress, if any. */
  get openSinceMs() { return this.open?.startMs; }
  get speaking() { return Boolean(this.open); }

  /** Returns a closed segment when one ends on this frame. */
  push(db: number, atMs: number, playbackActive: boolean): { opened?: number; closed?: SpeechSegment } {
    // Digital silence (a capture device still starting, a muted stream) is not
    // room tone: it would drag the floor to -120 dB and make the room "speech".
    const digitalSilence = db < -100;
    if (playbackActive) this.leadIn = [];
    else { this.leadIn.push({ db, atMs }); this.leadIn = this.leadIn.filter(f => atMs - f.atMs <= 140 + this.options.minSpeechMs); }
    if (!digitalSilence) this.realMs += frameMs;
    const threshold = Math.max(this.options.absoluteFloorDb, this.floorDb + this.options.onsetDb);
    const loud = !digitalSilence && db > threshold;
    if (!digitalSilence && !playbackActive && (!loud || this.realMs <= this.options.warmupMs)) {
      this.recent.push(db);
      if (this.recent.length > 150) this.recent.shift();
      const sorted = [...this.recent].sort((a, b) => a - b);
      this.floorDb = sorted[Math.floor(sorted.length * (this.realMs <= this.options.warmupMs ? 0.2 : 0.5))];
    }
    const warm = this.realMs >= this.options.warmupMs;
    const out: { opened?: number; closed?: SpeechSegment } = {};
    if (playbackActive && !this.open) { this.speechRun = 0; this.silenceRun = 0; return out; }
    if (loud) {
      this.speechRun += frameMs; this.silenceRun = 0;
      if (!this.open && warm && this.speechRun >= this.options.minSpeechMs && !playbackActive) {
        const confirmedStart = atMs - this.speechRun + frameMs;
        // Once speech is confirmed, retain its quiet lead-in (at most 140 ms).
        // The lower relative gate cannot open a segment by itself.
        const lead = this.leadIn.find(f => f.atMs >= confirmedStart - 140 && f.atMs <= confirmedStart && f.db > this.floorDb + this.options.onsetDb / 2);
        this.open = { startMs: lead?.atMs ?? confirmedStart, peakDb: db, overlapsPlayback: false };
        out.opened = this.open.startMs;
      }
      if (this.open) { this.open.peakDb = Math.max(this.open.peakDb, db); if (playbackActive) this.open.overlapsPlayback = true; }
    } else {
      this.silenceRun += frameMs;
      if (this.silenceRun >= frameMs * 3) this.speechRun = 0;
      if (this.open && this.silenceRun >= this.options.hangoverMs) {
        const closed: SpeechSegment = { startMs: this.open.startMs, endMs: atMs - this.silenceRun + frameMs, peakDb: Math.round(this.open.peakDb * 10) / 10, overlapsPlayback: this.open.overlapsPlayback };
        this.segments.push(closed); this.open = undefined; out.closed = closed;
      }
    }
    return out;
  }

  /** Close a segment still open at the end of a recording. */
  flush(atMs: number): SpeechSegment | undefined {
    if (!this.open) return undefined;
    const closed: SpeechSegment = { startMs: this.open.startMs, endMs: atMs, peakDb: Math.round(this.open.peakDb * 10) / 10, overlapsPlayback: this.open.overlapsPlayback };
    this.segments.push(closed); this.open = undefined; return closed;
  }
}

export class AudioLoop extends EventEmitter {
  playbackReceipts?: () => Promise<import('./speakerWait.ts').PlaybackReceipt[] | undefined>;

  private child?: ChildProcess;
  private pending = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private samplesSeen = 0;
  readonly vad: EnergyVad;
  readonly playbacks: PlaybackWindow[] = [];
  /** Mic-time start of the playback in progress. */
  private playing?: { startMs: number };
  private lastPlaybackEndMs = -Infinity;
  /** min(arrival wall time - mic sample time) over recent chunks: wall = micMs + offset. */
  private wallOffsets: Array<{ at: number; offset: number }> = [];
  private fifo?: string;
  private startedAt = 0;

  constructor(private readonly source: MicSource, private readonly options: VadOptions = defaultVad, private readonly cacheDir = join(tmpdir(), "mockingbird-say")) {
    super();
    this.vad = new EnergyVad(options);
    mkdirSync(cacheDir, { recursive: true });
  }

  /** ms of audio captured so far: the recorder's own clock. */
  nowMs() { return Math.round((this.samplesSeen / sampleRate) * 1000); }

  /**
   * The mic's sample clock and the Mac's wall clock. Audio reaches us in
   * buffered chunks, so a chunk's last sample was captured no later than when
   * it arrived; the smallest (arrival - sample time) seen recently is the best
   * estimate of the true offset. Use it for anything timed outside the mic
   * (playback, UI actions), never the sample count at that moment.
   */
  private wallOffset(): number {
    if (!this.wallOffsets.length) return Date.now() - this.nowMs();
    return Math.min(...this.wallOffsets.map((o) => o.offset));
  }
  micMsAt(wall: number): number { return Math.round(wall - this.wallOffset()); }
  wallAt(micMs: number): number { return Math.round(micMs + this.wallOffset()); }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    if (this.source.kind === "file") {
      const stream = createReadStream(this.source.path, { start: 44 });
      stream.on("data", (chunk) => this.ingest(chunk as Buffer));
      await new Promise<void>((done) => stream.on("end", () => done()));
      return;
    }
    if (this.source.kind === "ffmpeg") {
      this.child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
      this.child.stdout!.on("data", (chunk: Buffer) => this.ingest(chunk));
    } else {
      // A named pipe: LaunchServices starts the helper as its own app, so the
      // microphone permission is its own, and `open --stdout` streams to us.
      this.fifo = join(tmpdir(), `mockingbird-mic-${process.pid}-${Date.now()}.pcm`);
      execFileSync("mkfifo", [this.fifo]);
      this.child = spawn("open", ["-W", "-n", "--stdout", this.fifo, "--stderr", `${this.fifo}.err`, "-a", resolve(this.source.app)], { stdio: "ignore" });
      const stream = createReadStream(this.fifo);
      stream.on("data", (chunk) => this.ingest(chunk as Buffer));
    }
    const deadline = Date.now() + 15000;
    while (this.samplesSeen === 0) {
      if (Date.now() > deadline) throw new Error("Mac microphone produced no audio in 15 s. If the helper is used, allow 'Mockingbird Mic' in System Settings > Privacy & Security > Microphone.");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private ingest(chunk: Buffer) {
    this.chunks.push(chunk);
    if (this.source.kind !== "file") {
      const now = Date.now();
      const endMs = ((this.samplesSeen + (this.pending.length + chunk.length) / 2) / sampleRate) * 1000;
      this.wallOffsets.push({ at: now, offset: now - endMs });
      while (this.wallOffsets.length > 1 && now - this.wallOffsets[0].at > 20000) this.wallOffsets.shift();
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const frameBytes = frameSamples * 2;
    while (this.pending.length >= frameBytes) {
      const frame = new Int16Array(this.pending.buffer.slice(this.pending.byteOffset, this.pending.byteOffset + frameBytes));
      this.pending = this.pending.subarray(frameBytes);
      this.samplesSeen += frameSamples;
      const atMs = this.nowMs();
      const playbackActive = (this.playing !== undefined && atMs >= this.playing.startMs) || atMs < this.lastPlaybackEndMs + this.options.playbackTailMs;
      const db = frameDb(frame);
      const event = this.vad.push(db, atMs, playbackActive);
      if (event.opened !== undefined) this.emit("speechStart", event.opened);
      if (event.closed) this.emit("speechEnd", event.closed);
    }
  }

  /** Render a line with `say` (cached) and return the WAV path. */
  render(text: string, voice = "Samantha", rate = 185): string {
    const key = createHash("sha1").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 16);
    const file = join(this.cacheDir, `${key}.wav`);
    if (!existsSync(file)) execFileSync("say", ["-v", voice, "-r", String(rate), "-o", file, "--data-format=LEI16@22050", text]);
    return file;
  }

  /** Speak a line through the Mac's speaker; resolves when playback ends. */
  async say(text: string, voice?: string, rate = 185): Promise<PlaybackWindow> {
    const file = this.render(text, voice, rate);
    return this.play(file, text);
  }

  /** Play a file; times are on the mic clock, from wall time (see micMsAt). */
  async play(file: string, text = file): Promise<PlaybackWindow> {
    const startMs = this.micMsAt(Date.now());
    this.playing = { startMs };
    await new Promise<void>((done, fail) => {
      const child = spawn("afplay", [file], { stdio: "ignore" });
      child.on("exit", (code) => code === 0 ? done() : fail(new Error(`afplay exited ${code}`)));
    });
    const window: PlaybackWindow = { text, startMs, endMs: this.micMsAt(Date.now()), file };
    this.playing = undefined;
    this.lastPlaybackEndMs = window.endMs;
    this.playbacks.push(window);
    return window;
  }

  /**
   * Waits for the phone to speak and finish. Resolves with every segment that
   * started after `sinceMs`, merged across pauses shorter than `mergeGapMs`,
   * once the phone has been quiet for `quietMs` after its last segment, or
   * with what it has at `timeoutMs` (an empty list = no reply).
   */
  async awaitReply(sinceMs: number, opts: { timeoutMs: number; quietMs?: number }): Promise<SpeechSegment[]> {
    const quietMs = opts.quietMs ?? 2500;
    const deadline = this.nowMs() + opts.timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const now = this.nowMs();
      const segments = this.vad.segments.filter((s) => s.startMs >= sinceMs && !s.overlapsPlayback);
      if (segments.length && !this.vad.speaking && now - segments[segments.length - 1].endMs >= quietMs) return segments;
      if (now >= deadline && !this.vad.speaking) return segments;
      if (now >= deadline + 30000) return segments; // a reply that never ends
    }
  }

  /** The onset (mic ms) of the first app speech after `sinceMs`, as soon as it is detected; undefined on timeout. */
  async awaitOnset(sinceMs: number, timeoutMs: number): Promise<number | undefined> {
    const deadline = this.nowMs() + timeoutMs;
    for (;;) {
      const open = this.vad.openSinceMs;
      if (open !== undefined && open >= sinceMs) return open;
      const closed = this.vad.segments.find((s) => s.startMs >= sinceMs && !s.overlapsPlayback);
      if (closed) return closed.startMs;
      if (this.nowMs() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Wait until the app has been quiet for `quietMs` (no open speech segment and
   * the last one ended at least that long ago), up to `timeoutMs`. Returns how
   * long it waited and whether it timed out.
   */
  async awaitQuiet(quietMs: number, timeoutMs: number): Promise<{ waitedMs: number; timedOut: boolean }> {
    let rows: import('./speakerWait.ts').PlaybackReceipt[] = [];
    let active = true;
    let pending: Promise<void> | undefined;
    let lastPoll = -Infinity;
    const refresh = () => {
      if (!this.playbackReceipts || pending || this.nowMs() - lastPoll < 500) return;
      lastPoll = this.nowMs();
      pending = this.playbackReceipts().then(value => { if (active && value !== undefined) rows = value; })
        .catch(() => { /* Keep a known submission open on transient trace failure. */ }).finally(() => { pending = undefined; });
    };
    refresh();
    try { return await waitForSpeaker(quietMs, timeoutMs, () => ({
      now: this.nowMs(), speaking: this.vad.speaking, playing: this.playing !== undefined,
      receiptOngoing: receiptPlaybackOngoing(rows, this.wallAt(this.nowMs())),
      replyStarted: this.vad.segments.filter(s => !s.overlapsPlayback && s.startMs >= this.lastPlaybackEndMs)[0]?.startMs,
      lastEnd: Math.max(this.vad.segments.filter(s => !s.overlapsPlayback).at(-1)?.endMs ?? 0, this.lastPlaybackEndMs, 0),
    }), async () => { refresh(); await new Promise(r => setTimeout(r, 50)); });
    } finally { active = false; }
  }

  /** Wait until the mic clock reaches `micMs` (for lines timed against the app's speech). */
  async waitUntil(micMs: number) {
    while (this.nowMs() < micMs) await new Promise((r) => setTimeout(r, 10));
  }

  /** Sustained VAD speech, excluding rig playback and its tail. */
  speechActive(minSpeechMs: number): boolean {
    const now = this.nowMs(), openSince = this.vad.openSinceMs;
    return this.playing === undefined && now >= this.lastPlaybackEndMs + this.options.playbackTailMs
      && openSince !== undefined && now - openSince >= minSpeechMs;
  }

  /** Median of 1.5 s within the current speech segment, lagged 400 ms to
   * exclude phrase endings. Peak ceiling uses p95 of ALL recent frames,
   * including the lag, after playback/tail and the last volume press.
   * No measurement authorizes ordinary calibration presses. The controller may
   * undo one down after three unmeasurable speech ticks following the fresh window. */
  speechLevel(minSpeechMs: number, afterMs = -Infinity): { db: number; peakDb: number; overFloorDb: number } | undefined {
    const now = this.nowMs(), openSince = this.vad.openSinceMs;
    if (this.playing !== undefined || openSince === undefined) return undefined;
    const start = Math.max(openSince, this.lastPlaybackEndMs + this.options.playbackTailMs, afterMs);
    if (now - start < Math.max(minSpeechMs, 1900)) return undefined;
    const samples = this.samples(now - 1900, now);
    const levels: number[] = [];
    for (let i = 0; i + 320 <= samples.length; i += 320) levels.push(frameDb(samples.subarray(i, i + 320)));
    if (levels.length < 95) return undefined;
    const sustained = levels.slice(0, 75).sort((a, b) => a - b);
    const db = sustained[Math.floor(sustained.length / 2)];
    const peakDb = [...levels].sort((a, b) => a - b)[Math.ceil(levels.length * 0.95) - 1];
    const overFloorDb = db - this.vad.noiseFloorDb;
    // VAD hangover or digital silence is not measurable inaudible speech.
    return Number.isFinite(db) && db > -85 && overFloorDb >= 12 ? { db, peakDb, overFloorDb } : undefined;
  }

  /** Raw samples for [fromMs, toMs) of the capture. */
  samples(fromMs: number, toMs: number): Int16Array {
    const all = Buffer.concat(this.chunks);
    const from = Math.max(0, Math.floor((fromMs / 1000) * sampleRate) * 2);
    const to = Math.min(all.length, Math.floor((toMs / 1000) * sampleRate) * 2);
    const slice = all.subarray(from, Math.max(from, to));
    return new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length));
  }

  /**
   * Playback-to-mic offset: play a short 1 kHz tone `rounds` times and find
   * each tone's onset by its frequency (Goertzel), not by loudness, so room
   * noise cannot fake it. offsetMs = heard onset - playback start on the mic
   * clock: afplay start-up, output and input buffering, and the air. Every
   * latency figure subtracts it; a negative, huge or unstable offset means
   * the clocks cannot be trusted and latency checks must not pass.
   */
  async calibrate(rounds = 3): Promise<Calibration> {
    const tone = toneFile(this.cacheDir);
    const offsets: number[] = [];
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const played = await this.play(tone, "calibration tone");
      await new Promise((r) => setTimeout(r, 600));
      const onset = toneOnsetMs(this.samples(played.startMs - 300, played.startMs + 1500), 1000);
      if (onset !== undefined) offsets.push(Math.round(onset - 300));
    }
    return judgeCalibration(offsets, rounds);
  }

  /** Write [fromMs, toMs) of the capture to a WAV file. */
  slice(file: string, fromMs: number, toMs: number) {
    const all = Buffer.concat(this.chunks);
    const from = Math.max(0, Math.floor((fromMs / 1000) * sampleRate) * 2);
    const to = Math.min(all.length, Math.floor((toMs / 1000) * sampleRate) * 2);
    writeWav(file, all.subarray(from, Math.max(from, to)));
  }

  writeAll(file: string) { writeWav(file, Buffer.concat(this.chunks)); }

  async stop() {
    const end = this.vad.flush(this.nowMs());
    if (end) this.emit("speechEnd", end);
    this.child?.kill("SIGTERM");
    if (this.source.kind === "helper") {
      try { execFileSync("pkill", ["-f", "MockingbirdMic.app/Contents/MacOS/MockingbirdMic"]); } catch { /* already gone */ }
    }
    if (this.fifo) { rmSync(this.fifo, { force: true }); rmSync(`${this.fifo}.err`, { force: true }); }
  }
}

export function writeWav(file: string, pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
}

/** Local transcription with whisper.cpp; undefined when it is not installed. */
export function transcribe(wav: string, model = process.env.MOCKINGBIRD_WHISPER_MODEL ?? join(process.env.HOME ?? "", ".cache/mockingbird/ggml-base.en.bin")): string | undefined {
  if (!existsSync(model)) return undefined;
  try {
    const out = execFileSync("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np", "-l", "en", ...(process.env.MOCKINGBIRD_WHISPER_CPU === "1" ? ["-ng"] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
    return out.replace(/\s+/g, " ").trim();
  } catch { return undefined; }
}

/** transcribe() without blocking the event loop (the mic keeps streaming while whisper runs). */
export function transcribeAsync(wav: string, model = process.env.MOCKINGBIRD_WHISPER_MODEL ?? join(process.env.HOME ?? "", ".cache/mockingbird/ggml-base.en.bin")): Promise<string | undefined> {
  if (!existsSync(model)) return Promise.resolve(undefined);
  return new Promise((done) => {
    execFile("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np", "-l", "en", ...(process.env.MOCKINGBIRD_WHISPER_CPU === "1" ? ["-ng"] : [])], { encoding: "utf8", timeout: 60000 }, (error, stdout) => done(error ? undefined : stdout.replace(/\s+/g, " ").trim()));
  });
}

export interface Calibration { offsetMs?: number; spreadMs?: number; offsets: number[]; valid: boolean; reason?: string }

/** A calibration is trusted only if every round heard the tone, the offset is plausible, and stable. */
export function judgeCalibration(offsets: number[], rounds: number): Calibration {
  if (offsets.length < rounds) return { offsets, valid: false, reason: `tone heard in ${offsets.length} of ${rounds} rounds` };
  const sorted = [...offsets].sort((a, b) => a - b);
  const offsetMs = sorted[Math.floor(sorted.length / 2)];
  const spreadMs = sorted[sorted.length - 1] - sorted[0];
  if (offsetMs < -30) return { offsetMs, spreadMs, offsets, valid: false, reason: `negative offset ${offsetMs} ms: heard before it was played, so the clocks are wrong` };
  if (offsetMs > 1500) return { offsetMs, spreadMs, offsets, valid: false, reason: `implausible offset ${offsetMs} ms` };
  if (spreadMs > 150) return { offsetMs, spreadMs, offsets, valid: false, reason: `unstable offset (spread ${spreadMs} ms)` };
  return { offsetMs, spreadMs, offsets, valid: true };
}

/**
 * First 10 ms block that starts a run of `minBlocks` blocks whose tone power
 * is 20 dB over the slice's median block and dominates the block's total
 * energy, so a click or a burst of broadband noise is never mistaken for it.
 */
export function toneOnsetMs(samples: Int16Array, hz: number, minBlocks = 8): number | undefined {
  const block = 160; // 10 ms at 16 kHz
  const k = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  const powers: number[] = [];
  const ratios: number[] = [];
  for (let start = 0; start + block <= samples.length; start += block) {
    let s1 = 0, s2 = 0, energy = 0;
    for (let i = 0; i < block; i++) { const x = samples[start + i] / 32768; energy += x * x; const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - k * s1 * s2;
    powers.push(p);
    // A pure tone's Goertzel power is ~ energy * block / 2; broadband noise is far lower.
    ratios.push(energy > 0 ? p / (energy * block / 2) : 0);
  }
  if (!powers.length) return undefined;
  const median = [...powers].sort((a, b) => a - b)[Math.floor(powers.length / 2)] || 1e-12;
  const hit = powers.map((p, i) => p > median * 100 && p > 1e-6 && ratios[i] > 0.3);
  for (let i = 0; i + minBlocks <= hit.length; i++) if (hit.slice(i, i + minBlocks).every(Boolean)) return i * 10;
  return undefined;
}

/** A 150 ms 1 kHz tone with 5 ms ramps, written once. */
function toneFile(dir: string): string {
  const file = join(dir, "calibration-1khz.wav");
  if (existsSync(file)) return file;
  const n = Math.round(sampleRate * 0.15), ramp = Math.round(sampleRate * 0.005);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / ramp, (n - i) / ramp);
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.5 * 32767 * env), i * 2);
  }
  writeWav(file, pcm);
  return file;
}
