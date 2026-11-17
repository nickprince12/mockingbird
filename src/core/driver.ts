/**
 * Mac side of the phone driver: an HTTP command queue the XCUITest runner
 * long-polls (`GET /next`, `POST /result`), plus the `xcodebuild` process that
 * hosts the runner on a Simulator or a cable/Wi-Fi attached device.
 *
 * The runner polls us, rather than us connecting to it, so a device needs no
 * port forwarding: it only needs to reach the Mac (USB networking or the same
 * Wi-Fi), and the first run asks the phone once for Local Network access.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, relative, resolve } from "node:path";

export interface DriverOptions {
  /** A Simulator UDID, "sim" (first booted Simulator), or a device UDID. */
  device: string;
  bundleId: string;
  derivedDataPath: string;
  logFile: string;
  port?: number;
  /** Device runs need a signing team; Simulators do not sign. */
  developmentTeam?: string;
  /**
   * "poll" (default): the runner long-polls the Mac over the network (a
   * device needs Local Network permission, which iOS can deny silently to a
   * backgrounded runner). "usb": the runner listens on the device and the Mac
   * connects through `iproxy` over the cable (libimobiledevice), as
   * WebDriverAgent does. Devices only.
   */
  transport?: "poll" | "usb" | "auto";
}

interface Command { id: string; action: string; args: Record<string, unknown> }
export interface DriverResult { id: string; ok: boolean; value?: unknown; error?: string; ms?: number }
export interface ScreenText { type: string; label: string; value?: string; y?: number }

async function freeLocalPort(): Promise<number> {
  const { createServer: createNetServer } = await import("node:net");
  return await new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); });
  });
}

const projectPath = resolve(import.meta.dirname, "../../ios/MockingbirdDriver/MockingbirdDriver.xcodeproj");
const driverSourceRoot = resolve(import.meta.dirname, "../../ios/MockingbirdDriver");

/** Commands that need a newer driver than an old cached build may be: checked against the driver's hello. */
export const driverCapabilities = ["launchEnv"] as const;

/**
 * Hash of the driver's sources (Swift, project, plists). The built test bundle
 * is reused only while this matches the hash it was built from: a cached
 * build from older sources once silently ignored a new command argument
 * (2026-11-12: launch `env` was dropped, so a whole engine matrix ran against
 * the wrong app configuration while every launch reported ok).
 */
export function driverSourceHash(root = driverSourceRoot): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "xcuserdata" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const file of files) hash.update(relative(root, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

export function resolveDevice(device: string): { udid: string; simulator: boolean } {
  const sims = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" })) as { devices: Record<string, Array<{ udid: string; state: string; name: string }>> };
  const all = Object.values(sims.devices).flat();
  if (device === "sim") {
    const booted = all.find((d) => d.state === "Booted");
    if (!booted) throw new Error("No booted Simulator. Boot one (xcrun simctl boot <udid>) or pass --device <udid>.");
    return { udid: booted.udid, simulator: true };
  }
  const sim = all.find((d) => d.udid === device || d.name === device);
  if (sim && sim.state !== "Booted") {
    // Other sessions (or Xcode) can shut a Simulator down between runs.
    execFileSync("xcrun", ["simctl", "boot", sim.udid], { stdio: "ignore" });
    execFileSync("xcrun", ["simctl", "bootstatus", sim.udid, "-b"], { stdio: "ignore", timeout: 180000 });
  }
  return { udid: sim?.udid ?? device, simulator: Boolean(sim) };
}

/**
 * xcodebuild's "Timed out while enabling automation mode". On 2026-11-12 the toggle was ON
 * each time; the phone was showing iOS's sheet 'Enter iPhone Passcode for "XCTest" - Enable
 * UI Automation' (a periodic re-authorization, ~8 h apart that day). The rig cannot see that
 * sheet (XCTest is not running yet) and must never enter a passcode.
 */
export const UI_AUTOMATION_OFF = "Automation mode timed out on the test phone: it is most likely asking for its passcode to enable UI Automation for XCTest; enter it on the phone (or toggle Settings > Developer > Enable UI Automation off and on), then re-run";
/** The message builds before 2026-11-12 printed for the same signature (old run logs). */
export const UI_AUTOMATION_OFF_LEGACY = "UI Automation is off on the test phone: Settings > Developer > Enable UI Automation";
export const automationFailure = (log: string) => /Timed out while enabling automation mode/i.test(log);

export class PhoneDriver {
  private automationLog = "";
  private automationOff = false;
  private server?: Server;
  private queue: Command[] = [];
  private waiters: Array<(c: Command) => void> = [];
  private results = new Map<string, (r: DriverResult) => void>();
  private xcodebuild?: ChildProcess;
  private iproxy?: ChildProcess;
  private usbPort = 0;
  private seq = 0;
  private helloResolve?: (info: unknown) => void;
  info?: unknown;
  readonly udid: string;
  readonly simulator: boolean;
  /** Strings that must never reach a log file (e.g. a test credential typed into the app). */
  private readonly secrets: string[] = [];
  private readonly logTails = new Map<string, string>();
  /** Register a value to redact from the xcodebuild log (XCTest logs typed text). Call before typing it. */
  redact(secret: string) { if (secret && !this.secrets.includes(secret)) this.secrets.push(secret); }
  /** Redact registered secrets from log text. */
  scrub(text: string) { let out = text; for (const secret of this.secrets) out = out.split(secret).join("<redacted>"); return out; }
  /** Line-buffered per source, so a secret split across two chunks is still caught. */
  private writeLog(chunk: Buffer | string, prefix = "", flush = false) {
    if (!prefix) {
      const recent = this.automationLog + String(chunk);
      this.automationOff ||= automationFailure(recent);
      this.automationLog = recent.slice(-4096);
    }
    const text = (this.logTails.get(prefix) ?? "") + String(chunk);
    const cut = flush ? text.length - 1 : text.lastIndexOf("\n");
    this.logTails.set(prefix, text.slice(cut + 1));
    const complete = text.slice(0, cut + 1);
    if (!complete) return;
    const out = this.scrub(complete);
    appendFileSync(this.options.logFile, prefix ? out.split("\n").map((l) => (l ? prefix + l : l)).join("\n") : out);
  }
  readonly transcript: Array<{ atWall: number; action: string; args: unknown; ok: boolean; ms?: number; error?: string }> = [];

  private readonly options: DriverOptions;
  constructor(options: DriverOptions) {
    const resolved = resolveDevice(options.device);
    this.udid = resolved.udid; this.simulator = resolved.simulator;
    // "auto": USB on physical devices, polling on Simulators.
    this.options = !options.transport || options.transport === "auto" ? { ...options, transport: this.simulator ? "poll" : "usb" } : options;
  }

  private controlHost(): string {
    if (this.simulator) return "127.0.0.1";
    // A device reaches the Mac over its LAN address (Wi-Fi or USB networking).
    for (const list of Object.values(networkInterfaces())) for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
    throw new Error("No LAN address for the device to reach the Mac.");
  }

  async start(): Promise<void> {
    if (this.options.transport === "usb") return this.startUsb();
    const port = this.options.port ?? 8799;
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      if (request.url === "/next") {
        const command = this.queue.shift() ?? await new Promise<Command | undefined>((done) => {
          const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== take); done(undefined); }, 20000);
          const take = (c: Command) => { clearTimeout(timer); done(c); };
          this.waiters.push(take);
        });
        response.setHeader("content-type", "application/json");
        response.end(command ? JSON.stringify(command) : "{}");
        return;
      }
      if (request.url === "/result" && body) { this.results.get(body.id)?.(body); this.results.delete(body.id); }
      if (request.url === "/hello") { this.info = body; this.helloResolve?.(body); }
      response.end("ok");
    });
    const host = this.simulator ? "127.0.0.1" : "0.0.0.0";
    await new Promise<void>((done) => this.server!.listen(port, host, () => done()));
    const hello = new Promise((done) => { this.helloResolve = done; });
    const controlUrl = `http://${this.controlHost()}:${port}`;
    const args = ["test-without-building", "-project", projectPath, "-scheme", "MockingbirdUITests",
      "-destination", `id=${this.udid}`, "-derivedDataPath", this.options.derivedDataPath,
      "-only-testing:MockingbirdUITests/MockingbirdDriverTests/testServe"];
    this.ensureBuilt();
    this.xcodebuild = spawn("xcodebuild", args, {
      env: { ...process.env, TEST_RUNNER_MOCKINGBIRD_CONTROL_URL: controlUrl, TEST_RUNNER_MOCKINGBIRD_BUNDLE_ID: this.options.bundleId, TEST_RUNNER_MOCKINGBIRD_SESSION_SECONDS: "3600" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.xcodebuild.stdout?.on("data", (c) => this.writeLog(c));
    this.xcodebuild.stderr?.on("data", (c) => this.writeLog(c));
    const exited = new Promise((_, fail) => this.xcodebuild!.on("close", (code) => fail(new Error(this.automationOff ? UI_AUTOMATION_OFF : `xcodebuild exited ${code} before the driver connected; see ${this.options.logFile}`))));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(this.automationOff ? UI_AUTOMATION_OFF : `driver did not connect in 180 s; see ${this.options.logFile}`)), 180000); });
    try { await Promise.race([hello, exited, timeout]); } finally { clearTimeout(timer!); }
  }

  /**
   * Build the runner unless a build for this platform exists AND was made from
   * the current driver sources. Stamped per platform, so a Simulator build in
   * the same derived-data folder never stands in for a device build.
   */
  private ensureBuilt() {
    const platform = this.simulator ? "iphonesimulator" : "iphoneos";
    const products = join(this.options.derivedDataPath, "Build/Products");
    const stamp = join(this.options.derivedDataPath, `mockingbird-driver-${platform}.sha256`);
    const hash = driverSourceHash();
    const built = existsSync(products) && readdirSync(products).some((f) => f.includes(`_${platform}`) && f.endsWith(".xctestrun"));
    const current = built && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === hash;
    // Evidence for the automation-mode question (2026-11-12): a reused runner is the same signed
    // build; only a rebuild re-signs it. test-without-building still reinstalls it each session.
    if (current) { appendFileSync(this.options.logFile, `runner build reused (${platform}, driver sources unchanged since ${statSync(stamp).mtime.toISOString()})\n`); return; }
    appendFileSync(this.options.logFile, `build-for-testing ${this.udid} (${built ? "driver sources changed" : `no ${platform} build`})\n`);
    execFileSync("xcodebuild", this.buildArgs(), { stdio: ["ignore", "ignore", "ignore"], timeout: 600000 });
    writeFileSync(stamp, hash + "\n");
  }

  private buildArgs(): string[] {
    return ["build-for-testing", "-project", projectPath, "-scheme", "MockingbirdUITests", "-destination", `id=${this.udid}`, "-derivedDataPath", this.options.derivedDataPath,
      ...(this.simulator ? ["CODE_SIGNING_ALLOWED=NO"] : ["-allowProvisioningUpdates", ...(this.options.developmentTeam ? [`MOCKINGBIRD_DEVELOPMENT_TEAM=${this.options.developmentTeam}`] : [])])];
  }

  /** USB transport: iproxy forwards a Mac port to the runner's listener on the device. */
  private async startUsb(): Promise<void> {
    if (this.simulator) throw new Error("--usb is for devices; Simulators use the default transport");
    try { execFileSync("which", ["iproxy"], { stdio: "ignore" }); } catch { throw new Error("iproxy not found: brew install libimobiledevice"); }
    // The runner listens on a fixed port on the device; the Mac side gets a
    // fresh free port each run, so a leftover iproxy from an earlier run can
    // never hold it (2026-11-11: a stale iproxy on 8100 made every later run
    // fail with "Timed out while enabling automation mode").
    const devicePort = this.options.port ?? 8100;
    this.usbPort = await freeLocalPort();
    this.ensureBuilt();
    this.iproxy = spawn("iproxy", [`${this.usbPort}:${devicePort}`, "-u", this.udid], { stdio: ["ignore", "pipe", "pipe"] });
    const child = this.iproxy;
    process.once("exit", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } });
    this.iproxy.stdout?.on("data", (c) => this.writeLog(c, "[iproxy] "));
    this.iproxy.stderr?.on("data", (c) => this.writeLog(c, "[iproxy] "));
    this.xcodebuild = spawn("xcodebuild", ["test-without-building", "-project", projectPath, "-scheme", "MockingbirdUITests",
      "-destination", `id=${this.udid}`, "-derivedDataPath", this.options.derivedDataPath, "-only-testing:MockingbirdUITests/MockingbirdDriverTests/testServe"], {
      env: { ...process.env, TEST_RUNNER_MOCKINGBIRD_SERVER_PORT: String(devicePort), TEST_RUNNER_MOCKINGBIRD_BUNDLE_ID: this.options.bundleId, TEST_RUNNER_MOCKINGBIRD_SESSION_SECONDS: "3600" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.xcodebuild.stdout?.on("data", (c) => this.writeLog(c));
    this.xcodebuild.stderr?.on("data", (c) => this.writeLog(c));
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (this.automationOff) throw new Error(UI_AUTOMATION_OFF);
      if (this.xcodebuild.exitCode !== null) throw new Error(`xcodebuild exited ${this.xcodebuild.exitCode} before the driver listened; see ${this.options.logFile}`);
      const hello = await this.postUsb({ id: "hello", action: "hello", args: {} }, 3000).catch(() => undefined);
      if (hello?.ok) { this.info = hello.value; return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`driver did not answer over USB in 180 s; see ${this.options.logFile}`);
  }

  private async postUsb(command: Command, timeoutMs: number): Promise<DriverResult> {
    const response = await fetch(`http://127.0.0.1:${this.usbPort}/command`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(command), signal: AbortSignal.timeout(timeoutMs) });
    return await response.json() as DriverResult;
  }

  async run(action: string, args: Record<string, unknown> = {}, opts: { allowFail?: boolean } = {}): Promise<DriverResult> {
    // A driver that cannot apply a launch environment would launch the app
    // without it and still report ok.
    if (action === "launch" && args.env && !((this.info as { capabilities?: string[] } | undefined)?.capabilities)?.includes("launchEnv")) {
      throw new Error(`driver launch with env, but this driver build does not support a launch environment (capabilities: ${JSON.stringify((this.info as { capabilities?: string[] } | undefined)?.capabilities ?? [])}); it should have been rebuilt from current sources`);
    }
    if (this.options.transport === "usb") {
      const id = `c${++this.seq}`;
      const timeoutMs = ((args.timeout as number | undefined) ?? 10) * 1000 + 60000;
      const r = await this.postUsb({ id, action, args }, timeoutMs).catch((error) => ({ id, ok: false, error: `driver-transport: ${(error as Error).message}` }) as DriverResult);
      this.transcript.push({ atWall: Date.now(), action, args: action === "typeText" ? { ...args, text: "<redacted>" } : args, ok: r.ok, ms: r.ms, error: r.error && this.scrub(r.error) });
      if (!r.ok && !opts.allowFail) throw new Error(`driver ${action} failed: ${this.scrub(String(r.error))}`);
      return r;
    }
    const id = `c${++this.seq}`;
    const command: Command = { id, action, args };
    const result = new Promise<DriverResult>((done) => this.results.set(id, done));
    const waiter = this.waiters.shift();
    if (waiter) waiter(command); else this.queue.push(command);
    const timeoutMs = ((args.timeout as number | undefined) ?? 10) * 1000 + 60000;
    const r = await Promise.race([result, new Promise<DriverResult>((done) => setTimeout(() => done({ id, ok: false, error: "driver-timeout" }), timeoutMs))]);
    this.transcript.push({ atWall: Date.now(), action, args: action === "typeText" ? { ...args, text: "<redacted>" } : args, ok: r.ok, ms: r.ms, error: r.error && this.scrub(r.error) });
    if (!r.ok && !opts.allowFail) throw new Error(`driver ${action} failed: ${this.scrub(String(r.error))}`);
    return r;
  }

  async texts(): Promise<ScreenText[]> { return (await this.run("texts")).value as ScreenText[]; }

  async screenshot(file: string) {
    const r = await this.run("screenshot", {}, { allowFail: true });
    if (r.ok && typeof r.value === "string") writeFileSync(file, Buffer.from(r.value, "base64"));
  }

  async stop() {
    try { if (this.info) await Promise.race([this.run("quit", {}, { allowFail: true }), new Promise((r) => setTimeout(r, 5000))]); } catch { /* gone */ }
    this.xcodebuild?.kill("SIGTERM");
    this.iproxy?.kill("SIGTERM");
    this.server?.close();
    for (const prefix of [...this.logTails.keys()]) this.writeLog("", prefix, true);
  }
}
