/**
 * `mockingbird selftest --live [--mic helper|ffmpeg]`: Mac speaker -> Mac mic.
 *   1. Calibrates the playback-to-mic offset with a 1 kHz tone (3 rounds).
 *   2. Plays a spoken line with the playback mask off (here Mockingbird's own
 *      voice is the signal), detects it with the VAD and transcribes it.
 * Prints the offset, the speech onset relative to the audible start, and a
 * verdict. A negative or unstable offset fails: latency cannot be trusted.
 * `mockingbird selftest --offline`: VAD + whisper on a rendered file, no mic.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { micHelperPath } from "./adapters.ts";
import { AudioLoop, EnergyVad, defaultVad, transcribe, writeWav, sampleRate } from "./core/audio.ts";

const line = "What's first? Testing the mockingbird.";
const dir = join(tmpdir(), "mockingbird-selftest"); mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);

if (argv.includes("--offline")) {
  const raw = join(dir, "line.raw");
  execFileSync("say", ["-v", "Samantha", "-o", join(dir, "line.wav"), "--data-format=LEI16@16000", line]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, "line.wav"), "-f", "s16le", "-ac", "1", "-ar", String(sampleRate), raw]);
  const speech = readFileSync(raw);
  const pad = Buffer.alloc(sampleRate * 2); // 1 s of quiet noise each side
  for (let i = 0; i < pad.length; i += 2) pad.writeInt16LE(Math.round((Math.random() - 0.5) * 40), i);
  const pcm = Buffer.concat([pad, pad, speech, pad, pad]);
  const vad = new EnergyVad(defaultVad);
  for (let i = 0, ms = 0; i + 640 <= pcm.length; i += 640, ms += 20) {
    const frame = new Int16Array(pcm.buffer.slice(pcm.byteOffset + i, pcm.byteOffset + i + 640));
    let sum = 0; for (const s of frame) sum += s * s;
    const rms = Math.sqrt(sum / frame.length) / 32768;
    vad.push(rms > 0 ? 20 * Math.log10(rms) : -120, ms + 20, false);
  }
  vad.flush(Math.round(pcm.length / 32));
  const file = join(dir, "offline.wav"); writeWav(file, pcm);
  console.log(JSON.stringify({ mode: "offline", expectedOnsetMs: 2000, speechMs: Math.round(speech.length / 32), segments: vad.segments, transcript: transcribe(file) }, null, 2));
} else {
  const mic = argv.includes("--mic") ? argv[argv.indexOf("--mic") + 1] : "helper";
  // playbackTailMs very negative = the mask never applies: we want to hear ourselves.
  const loop = new AudioLoop(mic === "ffmpeg" ? { kind: "ffmpeg" } : { kind: "helper", app: micHelperPath() }, { ...defaultVad, playbackTailMs: -1e9 });
  await loop.start();
  await new Promise((r) => setTimeout(r, 1500));
  const floor = loop.vad.noiseFloorDb;
  const calibration = await loop.calibrate(3);
  await new Promise((r) => setTimeout(r, 800));
  const played = await (async () => { const file = loop.render(line); const p = loop.play(file, line); (loop as unknown as { playing?: unknown }).playing = undefined; return p; })();
  await new Promise((r) => setTimeout(r, 2000));
  await loop.stop();
  const audibleStart = played.startMs + (calibration.offsetMs ?? 0);
  const segs = loop.vad.segments.filter((s) => s.endMs > played.startMs && s.startMs < played.endMs + 1500);
  const out = join(dir, "live.wav"); loop.slice(out, Math.max(0, played.startMs - 300), played.endMs + 1200);
  const onsetVsAudible = segs[0] ? segs[0].startMs - audibleStart : null;
  const ok = calibration.valid && segs.length > 0 && onsetVsAudible !== null && Math.abs(onsetVsAudible) <= 250;
  console.log(JSON.stringify({ mode: "live", mic, noiseFloorDb: Math.round(floor * 10) / 10, calibration, playback: { startMs: played.startMs, endMs: played.endMs },
    segments: segs, speechOnsetVsAudibleStartMs: onsetVsAudible, transcript: transcribe(out), wav: out,
    verdict: ok ? "PASS" : "FAIL" }, null, 2));
  process.exitCode = ok ? 0 : 1;
}
