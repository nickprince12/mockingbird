/**
 * `mockingbird sim-audio-check --device <simulator-udid> [--mic helper|ffmpeg]`
 *
 * Does a Simulator's audio actually reach the Mac, and the Mac's reach it?
 * Independent of any app under test: it opens a local page in the
 * Simulator's Safari (the same WebKit audio and getUserMedia path a web-view
 * app uses) and checks both directions:
 *   output: the page plays a 1 kHz tone; the Mac mic must hear it (by frequency);
 *   output while capturing: the same tone with getUserMedia open, as a voice app plays;
 *   input:  the page measures its mic level while the Mac speaks; speech must
 *           rise clearly above the quiet before it;
 *   native input: the runner (an iOS app on the device) measures the mic with
 *           AVAudioEngine, separating "no Mac input at all" from "WebKit gets none".
 * (Native *output* cannot be tested from the runner: it plays from the
 * background, where iOS silences apps without background audio.)
 * Prints a verdict per direction. Free: no backend, no provider.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AudioLoop, toneOnsetMs, type MicSource } from "./core/audio.ts";
import { PhoneDriver } from "./core/driver.ts";
import { micHelperPath } from "./adapters.ts";

const argv = process.argv.slice(2);
const value = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const port = Number(value("--port", "8798"));
const safari = "com.apple.mobilesafari";
const runnerBundleId = "app.mockingbird.mockingbird.driver.xctrunner";

const page = `<!doctype html><meta name=viewport content="width=device-width"><body style="font:20px -apple-system;padding:24px">
<button id=tone style="font-size:22px;padding:14px;margin:8px">Play tone</button>
<button id=mic style="font-size:22px;padding:14px;margin:8px">Measure mic</button>
<button id=duplex style="font-size:22px;padding:14px;margin:8px">Tone while capturing</button>
<p id=out>ready</p>
<script>
const out = document.getElementById('out');
document.getElementById('tone').onclick = async () => {
  const ctx = new AudioContext(); await ctx.resume();
  const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.frequency.value = 1000; gain.gain.value = 0.5; osc.connect(gain).connect(ctx.destination);
  osc.start(); setTimeout(() => { osc.stop(); out.textContent = 'tone done'; fetch('/event?tone=done'); }, 1500);
  out.textContent = 'tone playing'; fetch('/event?tone=start');
};
document.getElementById('duplex').onclick = async () => {
  // What a voice app does: capture is open (play-and-record session) while it speaks.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext(); await ctx.resume();
  ctx.createMediaStreamSource(stream);
  const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.frequency.value = 1000; gain.gain.value = 0.5; osc.connect(gain).connect(ctx.destination);
  osc.start(); fetch('/event?duplex=start');
  setTimeout(() => { osc.stop(); stream.getTracks().forEach(t => t.stop()); out.textContent = 'duplex done'; fetch('/event?duplex=done'); }, 1500);
};
document.getElementById('mic').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext(); await ctx.resume();
    const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
    const buf = new Float32Array(an.fftSize); const levels = [];
    fetch('/event?mic=start');
    const t0 = performance.now();
    const tick = () => {
      an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v;
      levels.push({ t: Math.round(performance.now() - t0), db: Math.round(10 * Math.log10(s / buf.length + 1e-12)) });
      if (performance.now() - t0 < 6000) setTimeout(tick, 100);
      else { stream.getTracks().forEach(t => t.stop()); out.textContent = 'mic done'; fetch('/levels', { method: 'POST', body: JSON.stringify(levels) }); }
    };
    tick(); out.textContent = 'measuring';
  } catch (e) { out.textContent = 'mic error ' + e; fetch('/levels', { method: 'POST', body: JSON.stringify({ error: String(e) }) }); }
};
</script>`;

const events: Array<{ at: number; event: string }> = [];
let levels: unknown;
const server = createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(page); return; }
  if (req.url?.startsWith("/event")) { events.push({ at: Date.now(), event: req.url.split("?")[1] ?? "" }); res.end("ok"); return; }
  if (req.url === "/levels") { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); levels = JSON.parse(Buffer.concat(c).toString()); res.end("ok"); return; }
  res.statusCode = 404; res.end();
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

const mic = value("--mic", "helper");
const source: MicSource = mic === "ffmpeg" ? { kind: "ffmpeg" } : { kind: "helper", app: micHelperPath() };
const audio = new AudioLoop(source);
const driver = new PhoneDriver({ device: value("--device", "sim")!, bundleId: safari, derivedDataPath: value("--derived-data", join(tmpdir(), "mockingbird-dd"))!, logFile: join(tmpdir(), "mockingbird-simcheck-xcodebuild.log") });
const result: Record<string, unknown> = { device: driver.udid, simulatorAppRunning: (() => { try { execFileSync("pgrep", ["-x", "Simulator"]); return true; } catch { return false; } })() };
try {
  if (!driver.simulator) throw new Error("sim-audio-check is for Simulators");
  execFileSync("xcrun", ["simctl", "privacy", driver.udid, "grant", "microphone", safari], { stdio: "ignore" });
  // Grant before the runner starts: `simctl privacy` terminates a running app.
  try { execFileSync("xcrun", ["simctl", "privacy", driver.udid, "grant", "microphone", runnerBundleId], { stdio: "ignore" }); } catch { /* not installed yet */ }
  await audio.start(); await new Promise((r) => setTimeout(r, 1500));
  execFileSync("xcrun", ["simctl", "openurl", driver.udid, `http://127.0.0.1:${port}/`]);
  await driver.start();
  await driver.run("waitFor", { label: "Play tone", type: "button", timeout: 20 });

  // Output: Simulator -> Mac.
  const before = audio.micMsAt(Date.now());
  await driver.run("tap", { label: "Play tone", type: "button" });
  await new Promise((r) => setTimeout(r, 2500));
  const onset = toneOnsetMs(audio.samples(before, audio.micMsAt(Date.now())), 1000);
  result.output = { heardTone: onset !== undefined, toneOnsetAfterTapMs: onset ?? null, pagePlayedTone: events.some((e) => e.event === "tone=start") };

  // Input: Mac -> Simulator. Quiet for ~2 s, then the Mac speaks for ~3 s.
  levels = undefined;
  await driver.run("tap", { label: "Measure mic", type: "button" });
  await driver.run("allowSystemAlerts", { timeout: 3, labels: ["Allow", "OK"] }, { allowFail: true });
  const started = Date.now(); while (!events.some((e) => e.event === "mic=start" && e.at >= started - 4000) && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 2000));
  await audio.say("This is the Mac speaking to the simulator. One, two, three, four, five.");
  const deadline = Date.now() + 10000; while (levels === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (levels && !Array.isArray(levels)) result.input = { error: (levels as { error?: string }).error };
  else if (Array.isArray(levels)) {
    const l = levels as Array<{ t: number; db: number }>;
    const quiet = l.filter((x) => x.t < 1800).map((x) => x.db), loud = l.filter((x) => x.t >= 2200 && x.t < 5000).map((x) => x.db);
    const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? -120;
    const max = (a: number[]) => Math.max(-120, ...a);
    result.input = { quietMedianDb: med(quiet), speechMaxDb: max(loud), riseDb: max(loud) - med(quiet), heardMac: max(loud) - med(quiet) >= 10 && max(loud) > -100, allSilent: l.every((x) => x.db <= -100) };
  } else result.input = { error: "page never reported levels (permission prompt?)" };

  // Output while capturing (play-and-record session), as a voice app plays.
  const beforeDuplex = audio.micMsAt(Date.now());
  await driver.run("tap", { label: "Tone while capturing", type: "button" });
  await new Promise((r) => setTimeout(r, 3000));
  const duplexOnset = toneOnsetMs(audio.samples(beforeDuplex, audio.micMsAt(Date.now())), 1000);
  result.outputWhileCapturing = { heardTone: duplexOnset !== undefined, toneOnsetAfterTapMs: duplexOnset ?? null, pagePlayedTone: events.some((e) => e.event === "duplex=start") };

  // Native input: the same device's microphone through AVAudioEngine inside the
  // XCUITest runner, while the Mac speaks again. Separates "the Simulator gets
  // no Mac input at all" from "WebKit capture gets none".
  const nativeLevels = driver.run("micLevel", { seconds: 6, timeout: 20 }, { allowFail: true });
  await new Promise((r) => setTimeout(r, 2200));
  await audio.say("Now the Mac is speaking to the native microphone. Six, seven, eight, nine, ten.");
  const native = await nativeLevels;
  if (!native.ok) result.nativeInput = { error: native.error };
  else {
    const l = native.value as Array<{ t: number; db: number }>;
    const quiet = l.filter((x) => x.t < 1800).map((x) => x.db), loud = l.filter((x) => x.t >= 2200).map((x) => x.db);
    const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? -120;
    const max = (a: number[]) => Math.max(-120, ...a);
    result.nativeInput = { quietMedianDb: med(quiet), speechMaxDb: max(loud), riseDb: max(loud) - med(quiet), heardMac: max(loud) - med(quiet) >= 10 && max(loud) > -100, allSilent: l.every((x) => x.db <= -100), frames: l.length };
  }
  await driver.screenshot(join(tmpdir(), "mockingbird-simcheck.png"));
} catch (error) { result.error = (error as Error).message; }
finally { await driver.stop().catch(() => undefined); await audio.stop(); server.close(); }
const output = result.output as { heardTone?: boolean } | undefined, input = result.input as { heardMac?: boolean } | undefined;
const nativeInput = result.nativeInput as { heardMac?: boolean } | undefined;
const duplex = result.outputWhileCapturing as { heardTone?: boolean } | undefined;
result.verdict = { simulatorToMac: output?.heardTone ? "PASS" : "FAIL", simulatorToMacWhileCapturing: duplex?.heardTone ? "PASS" : "FAIL", macToSimulatorWebKit: input?.heardMac ? "PASS" : "FAIL", macToSimulatorNative: nativeInput?.heardMac ? "PASS" : "FAIL" };
result.pageEvents = events.map((e) => e.event);
console.log(JSON.stringify(result, null, 2));
