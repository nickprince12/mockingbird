/**
 * Device volume, set only while the app under test is audibly speaking.
 *
 * iOS volume buttons change the volume of whatever is playing; in silence they
 * often change the ringer. So this controller presses only while the Mac mic
 * hears the app's speech: voice has started, the VAD has heard sustained speech
 * (a 1.5 s median, excluding the latest 400 ms), and Mockingbird is not playing. It
 * steers the app's level toward a target band over the noise floor, so it
 * settles at the lowest level that is still clearly detectable (and presses
 * down when it is louder than needed). Safety stops: at most `maxPresses`, and
 * it gives up when two presses in a row leave the *measured* level unchanged
 * (within 1.5 dB): the press is not reaching the playing audio. The device's
 * reported media volume is logged but not trusted: a call-style (voice chat)
 * session has its own volume, which the media reading does not show.
 */
import type { AudioLoop } from "./audio.ts";
import type { AudioProfile } from "./profile.ts";
import type { PhoneDriver } from "./driver.ts";

export interface LevelControllerOptions {
  /** Target band for the app's speech level over the noise floor, dB. */
  lowDb?: number;
  /** Quieter measurable call route (17–24 dB, absolute up/down -38/-36 dBFS). */
  quietTarget?: boolean;
  previous?: AudioProfile["callLevel"];
  onSettled?: (level: NonNullable<AudioProfile["callLevel"]>) => void;
  /** Injectable settling delay for offline simulations. */
  wait?: () => Promise<void>;
  highDb?: number;
  maxPresses?: number;
  /** Stop once the level has been in band for this much speech. */
  settleMs?: number;
  log?: (line: string) => void;
}

export interface LevelLog { atMs: number; levelOverFloorDb: number; peakDb?: number; press?: "up" | "down"; volumeAfter?: number }

export class DeviceLevelController {
  readonly history: LevelLog[] = [];
  private presses = 0;
  private netPresses = 0;
  private anchoring = false;
  private measured = false;
  private finalLevel?: number;
  private estimatedStepDb = 3;
  private measuredSteps = 0;
  private missingAfterDown = 0;
  private lastDirection?: "up" | "down";
  private startedInaudible = false;
  private measurementAfterMs = -Infinity;
  private unchanged = 0;
  private inBandMs = 0;
  private stopped?: string;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastVolume?: number;
  private levelBeforePress?: number;

  constructor(private readonly driver: PhoneDriver, private readonly audio: AudioLoop, private readonly options: LevelControllerOptions = {}) {}

  get result() {
    return { presses: this.presses, netPresses: this.netPresses, previous: this.options.previous, finalLevelOverFloorDb: this.finalLevel, stoppedBecause: this.stopped ?? "run ended", finalVolume: this.lastVolume, history: this.history };
  }

  start() {
    this.timer = setInterval(() => { void this.tick(); }, 300);
  }

  stop(reason = "run ended") {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped ??= reason;
  }

  async tick() {
    if (this.busy || this.stopped) return;
    const low = this.options.lowDb ?? (this.options.quietTarget ? 17 : 20), high = this.options.highDb ?? (this.options.quietTarget ? 24 : 30), max = this.options.maxPresses ?? 16;
    const level = this.audio.speechLevel(1900, this.measurementAfterMs);
    if (!level) {
      this.inBandMs = 0;
      // A down can put speech below the measurement threshold. Do not let the
      // missing-level return bypass the one-step undo (458b).
      if (this.lastDirection === "down" && this.audio.nowMs() - this.measurementAfterMs >= 1900 && this.audio.speechActive(1900)) {
        if (++this.missingAfterDown >= 3 && this.presses < max) {
          this.busy = true;
          try {
            const r = await this.driver.run("pressButton", { button: "volumeUp" }, { allowFail: true });
            if (r.ok) { this.presses++; this.netPresses++; this.lastVolume = Number(r.value); }
            this.stop(r.ok ? "recovered one down after three unmeasurable speech ticks" : `recovery press failed: ${r.error}`);
          } finally { this.busy = false; }
        }
      } else this.missingAfterDown = 0;
      return;
    }
    this.missingAfterDown = 0;
    this.busy = true;
    try {
      const entry: LevelLog = { atMs: this.audio.nowMs(), levelOverFloorDb: Math.round(level.overFloorDb * 10) / 10 };
      entry.peakDb = level.peakDb;
      this.history.push(entry);
      this.finalLevel = level.overFloorDb;
      const ceiling = level.overFloorDb > 32 || level.peakDb > (this.options.quietTarget ? -36 : -33);
      const upBlocked = level.peakDb > (this.options.quietTarget ? -38 : -36);
      if (!this.measured) {
        // A persisted call route is measured before any press. Never replay an
        // old positive press count: that would raise the same route every run.
        this.anchoring = level.overFloorDb > high || ceiling;
        // Only a sustained first measurement below the old audibility cutoff
        // grants an exception to the net-up cap. Silence never grants it.
        this.startedInaudible = level.overFloorDb < 15 && !upBlocked;
        this.measured = true;
      }
      if (this.levelBeforePress !== undefined) {
        if (Math.abs(level.overFloorDb - this.levelBeforePress) < 1.5) {
          if (++this.unchanged >= 2) { this.stop("two presses did not change the measured level; stopped so presses cannot reach any other setting"); return; }
        } else {
          this.unchanged = 0;
          this.measuredSteps++;
          this.estimatedStepDb = Math.max(this.estimatedStepDb, Math.abs(level.overFloorDb - this.levelBeforePress));
        }
        this.levelBeforePress = undefined;
      }
      const canDown = level.overFloorDb >= Math.max(low, this.options.quietTarget ? 17 : 18) + (this.options.quietTarget ? 1.5 : 1) * this.estimatedStepDb;
      if (this.anchoring && !canDown) this.anchoring = false;
      if (!this.anchoring && !(ceiling && canDown) && level.overFloorDb >= low && level.overFloorDb <= high) {
        this.inBandMs += 300;
        if (this.inBandMs >= (this.options.settleMs ?? 2000)) {
          // Settlement is permanent: later quieter phrases must not restart calibration
          // and ratchet the call volume up during the same run.
          this.stop(`settled in band (${low}-${high} dB over floor)`);
          try { this.options.onSettled?.({ netPresses: (this.options.previous?.netPresses ?? 0) + this.netPresses,
            levelOverFloorDb: level.overFloorDb, peakDb: level.peakDb, presses: this.presses }); }
          catch (error) { this.options.log?.(`  call-level profile save failed: ${String(error)}`); }
        }
        return;
      }
      this.inBandMs = 0;
      if (this.presses >= max) { this.stop(`press cap (${max})`); return; }
      const direction = this.anchoring || ceiling || level.overFloorDb > high ? "down" : "up";
      if (this.options.quietTarget && this.measuredSteps === 0 && Math.abs(level.overFloorDb - low) <= 4) { this.stop("unmeasured step within 4 dB of band floor"); return; }
      if (direction === "down" && !canDown) { this.stop(`down guard: estimated step would cross band floor or ${this.options.quietTarget ? 17 : 18} dB`); return; }
      if (direction === "up" && upBlocked) return;
      if (direction === "up" && !this.startedInaudible && this.netPresses >= 2) {
        this.stop("net up cap (2)"); return;
      }
      const r = await this.driver.run("pressButton", { button: direction === "up" ? "volumeUp" : "volumeDown" }, { allowFail: true });
      if (!r.ok) { this.stop(`press failed: ${r.error}`); return; }
      this.presses++;
      this.lastDirection = direction;
      this.netPresses += direction === "up" ? 1 : -1;
      const volume = Number(r.value);
      entry.press = direction; entry.volumeAfter = volume;
      this.levelBeforePress = level.overFloorDb;
      this.lastVolume = volume;
      this.measurementAfterMs = this.audio.nowMs();
      this.options.log?.(`  level ${entry.levelOverFloorDb} dB over floor -> volume ${direction} (reported media ${Math.round(volume * 100)}%)`);
      await (this.options.wait?.() ?? new Promise((r) => setTimeout(r, 700))); // speechLevel also requires 1.9 s of fresh speech after the press
    } finally { this.busy = false; }
  }
}
