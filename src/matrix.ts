/**
 * An engine matrix: the same scripted scenario(s), once per arm, then a
 * side-by-side comparison.
 *
 *   mockingbird matrix --arms <arms.json | id> --scenario <id>[,<id>...] [--only a,b] [--pause <s>] [run options]
 *
 * An arms file is `{ "id": "...", "description": "...", "arms": [Arm, ...] }`
 * (see run.ts `Arm`): each arm patches the scenario, usually its launchEnv
 * (the app's engine/backend switch), its engine and its status expectations.
 * A bare id resolves to <scenarios-dir>/arms/<id>.json.
 *
 * Arms run one after another (one phone), each as a normal `run` in its own
 * process with every other option passed through, into
 * <reports>/<time>-matrix-<arms id>/<scenario>/. When they finish, each
 * scenario folder gets comparison.md + comparison.json, and the matrix folder
 * an index.md.
 *
 * Watchdog (core/health.ts): after every arm, one line says ok, PRODUCT-FAIL
 * or INFRA-FAIL. A product failure (the app did something wrong) never stops
 * later arms. An infrastructure failure (no first words, the app on the wrong
 * engine, the driver or ensureReady failing, UI Automation off, 4+ lines
 * unanswered, no report) aborts the matrix: every later arm would fail the
 * same way and spend for nothing. `--keep-going` disables the abort;
 * `--unanswered-infra <n>` moves the unanswered-lines threshold. The lines
 * go to the console and to <matrix>/health.log; health.json has every arm.
 *
 * `--watch-automation` (devices): log the phone's own Automation Mode
 * messages next to the arm boundaries in <matrix>/automation-mode.log
 * (core/automationWatch.ts), to find what turns UI Automation off.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { PhoneDriver, UI_AUTOMATION_OFF, resolveDevice } from "./core/driver.ts";
import { loadAdapter } from "./adapters.ts";
import { tmpdir } from "node:os";
import type { Arm } from "./run.ts";
import { writeComparison } from "./compare.ts";
import { classifyRunDir, healthLine, type RunHealth } from "./core/health.ts";
import { appendFileSync } from "node:fs";
import { AutomationWatch, UI_AUTOMATION_REMEDY } from "./core/automationWatch.ts";

export interface ArmsFile { id: string; description?: string; arms: Arm[] }

export function loadArms(ref: string, scenariosDir?: string): ArmsFile {
  const path = existsSync(ref) ? ref : scenariosDir ? join(scenariosDir, "arms", `${ref}.json`) : ref;
  if (!existsSync(path)) throw new Error(`No arms file ${ref} (looked for ${path})`);
  const file = JSON.parse(readFileSync(path, "utf8")) as ArmsFile;
  if (!file.id || !Array.isArray(file.arms) || !file.arms.length) throw new Error(`${path}: needs an id and at least one arm`);
  const ids = new Set<string>();
  for (const arm of file.arms) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(arm.id)) throw new Error(`${path}: arm id ${JSON.stringify(arm.id)} must be a plain slug`);
    if (ids.has(arm.id)) throw new Error(`${path}: duplicate arm ${arm.id}`);
    ids.add(arm.id);
  }
  return file;
}

/** Options the matrix consumes; everything else goes to each run. */
const own = new Set(["--arms", "--scenario", "--only", "--pause", "--reports", "--unanswered-infra"]);
/** Matrix-only flags without a value. */
const ownFlags = new Set(["--keep-going", "--watch-automation"]);
export function passthrough(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (own.has(argv[i])) { i++; continue; }
    if (ownFlags.has(argv[i])) continue;
    out.push(argv[i]);
  }
  return out;
}

/** Test seams: how one arm's run is started, and the automation preflight. */
export interface MatrixDeps {
  runArm?: (args: string[]) => { status: number | null };
  preflight?: (matrixDir: string) => Promise<boolean>;
  pauseMs?: number;
}

export async function main(argv = process.argv.slice(3), deps: MatrixDeps = {}) {
  const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const armsRef = value("--arms");
  const scenarios = value("--scenario")?.split(",").filter(Boolean) ?? [];
  if (!armsRef || !scenarios.length) throw new Error("usage: mockingbird matrix --arms <arms.json | id> --scenario <id>[,<id>...] [--only a,b] [--pause <s>] [run options]");
  const file = loadArms(armsRef, value("--scenarios-dir"));
  const only = value("--only")?.split(",");
  const arms = only ? file.arms.filter((a) => only.includes(a.id)) : file.arms;
  if (!arms.length) throw new Error(`--only ${only} matched no arm of ${file.id} (${file.arms.map((a) => a.id).join(", ")})`);
  const pauseMs = deps.pauseMs ?? Number(value("--pause") ?? "20") * 1000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = resolve(value("--reports") ?? process.env.MOCKINGBIRD_REPORTS ?? "reports/mockingbird");
  const matrixDir = join(root, `${stamp}-matrix-${file.id}`);
  mkdirSync(matrixDir, { recursive: true });
  const rest = passthrough(argv);
  const cli = resolve(import.meta.dirname, "cli.ts");
  const results: Array<{ scenario: string; arm: string; exit: number | null; runDir?: string; health?: RunHealth; spendUsd?: number; spendFinal?: boolean; spendEstimated?: boolean; readableReport?: boolean }> = [];
  const keepGoing = argv.includes("--keep-going");
  const unansweredInfraAt = Number(value("--unanswered-infra") ?? "4");
  const total = scenarios.length * arms.length;
  let aborted: string | undefined;

  console.log(`matrix ${file.id}: ${arms.map((a) => a.id).join(", ")} x ${scenarios.join(", ")} -> ${matrixDir}`);
  // Launch only the XCUITest driver for preflight. Once per matrix.
  const preflight = deps.preflight ?? (async (dir: string) => {
    const adapter = value("--adapter") ? await loadAdapter(value("--adapter")) : undefined;
    const driver = new PhoneDriver({ device: value("--device") ?? "sim", bundleId: value("--bundle") ?? adapter?.bundleId ?? "",
      derivedDataPath: value("--derived-data") ?? join(tmpdir(), "mockingbird-dd"), logFile: join(dir, "xcodebuild.log"),
      developmentTeam: value("--team") ?? process.env.MOCKINGBIRD_DEVELOPMENT_TEAM ?? adapter?.developmentTeam?.(),
      transport: argv.includes("--poll") || process.env.MOCKINGBIRD_TRANSPORT === "poll" ? "poll" : argv.includes("--usb") || process.env.MOCKINGBIRD_TRANSPORT === "usb" ? "usb" : "auto" });
    return await automationPreflight(driver, dir);
  });
  const device = value("--device") ?? "sim";
  const watch = argv.includes("--watch-automation") && device !== "sim" && !resolveDevice(device).simulator
    ? new AutomationWatch(device, join(matrixDir, "automation-mode.log")) : undefined;
  watch?.start();
  try {
  if (!await preflight(matrixDir)) { process.exitCode = 1; return; }
  const runArm = deps.runArm ?? ((args: string[]) => spawnSync(process.execPath, [...process.execArgv, cli, ...args], { stdio: "inherit" }));
  for (const scenario of scenarios) {
    const dir = join(matrixDir, scenario);
    mkdirSync(dir, { recursive: true });
    for (const [n, arm] of arms.entries()) {
      if (results.length && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs)); // let the previous session close
      console.log(`\n=== ${scenario} / ${arm.id}${arm.label ? ` (${arm.label})` : ""} [${n + 1}/${arms.length}] ===`);
      const before = new Set(readdirSync(dir));
      watch?.mark(`arm start ${scenario} / ${arm.id}`);
      const child = runArm(["run", ...rest, "--scenario", scenario, "--arm", JSON.stringify(arm), "--reports", dir]);
      const runDir = readdirSync(dir).find((d) => !before.has(d) && existsSync(join(dir, d, "report.json")));
      const runPath = runDir ? join(dir, runDir) : undefined;
      const health = classifyRunDir(runPath, child.status, { unansweredInfraAt });
      watch?.mark(`arm end ${scenario} / ${arm.id}: ${health.health}`);
      let spendReport: any;
      try { spendReport = runPath ? JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) : undefined; }
      catch { /* Missing/partial report: spend unknown; health retains missingReport. */ }
      results.push({ scenario, arm: arm.id, exit: child.status, runDir: runPath, health, spendUsd: spendReport?.spendUsd, spendFinal: spendReport?.polledSpend?.final, spendEstimated: spendReport?.polledSpend?.estimated, readableReport: Boolean(spendReport) });
      const line = healthLine(`[${results.length}/${total}] ${scenario} / ${arm.id}`, health);
      console.log(`\nWATCHDOG ${line}`);
      appendFileSync(join(matrixDir, "health.log"), `${new Date().toISOString()} ${line}\n`);
      writeFileSync(join(matrixDir, "health.json"), JSON.stringify(results.map((r) => ({ scenario: r.scenario, arm: r.arm, exit: r.exit, runDir: r.runDir, ...r.health })), null, 2));
      const automationOff = runPath && existsSync(join(runPath, "run.log")) && readFileSync(join(runPath, "run.log"), "utf8").includes(UI_AUTOMATION_OFF);
      if (automationOff || (health.health === "infra" && !keepGoing)) {
        aborted = `${scenario} / ${arm.id}: ${automationOff ? `${UI_AUTOMATION_OFF}. ${UI_AUTOMATION_REMEDY}` : health.reasons.join("; ")}`;
        break;
      }
    }
    const runs = results.filter((r) => r.scenario === scenario && r.runDir && r.readableReport).map((r) => r.runDir!);
    if (runs.length) { writeComparison(runs, dir, `${file.id}: ${scenario}`); console.log(`comparison: ${join(dir, "comparison.md")}`); }
    if (aborted) break;
  }
  const skipped = total - results.length;
  const tag = (h?: RunHealth) => h ? ({ ok: "ok", "product-fail": "PRODUCT-FAIL", infra: "INFRA-FAIL" }[h.health] + (h.health === "ok" ? "" : `: ${h.reasons.join("; ").replace(/\|/g, "/")}`)) : "-";
  const abortNote = aborted ? `\n**Aborted** after an infrastructure failure (${aborted.replace(/\|/g, "/")}); ${skipped} arm run(s) not started. Fix the rig, then re-run those (\`--keep-going\` disables the abort).\n` : "";
  const index = `# Matrix ${file.id}\n\n${file.description ?? ""}\n\nStarted ${stamp}. Arms: ${arms.map((a) => `\`${a.id}\`${a.label ? ` (${a.label})` : ""}`).join(", ")}.\n${abortNote}\n| scenario | arm | exit | health | polled spend | run |\n|---|---|---|---|---|---|\n${results.map((r) => `| ${r.scenario} | ${r.arm} | ${r.exit} | ${tag(r.health)} | ${r.spendUsd === undefined ? "spend unknown" : `$${r.spendUsd.toFixed(3)}${r.spendFinal === false ? ` (lower bound${r.spendEstimated ? "; estimated STT/TTS" : ""}; final spend unknown)` : ""}`} | ${r.runDir ? r.runDir.slice(matrixDir.length + 1) : "no report"} |`).join("\n")}\n\nComparisons: ${scenarios.map((s) => `[${s}](${s}/comparison.md)`).join(", ")}\n`;
  writeFileSync(join(matrixDir, "index.md"), index);
  if (aborted) {
    writeFileSync(join(matrixDir, "summary.md"), `# Matrix aborted\n\n${aborted}\n\n${skipped} arm run(s) not started. See health.log and index.md.\n`);
    writeFileSync(join(matrixDir, "run.log"), `ABORTED: ${aborted}\n`);
    console.log(`\nmatrix ABORTED (infrastructure): ${aborted}\n${skipped} arm run(s) not started; ${join(matrixDir, "index.md")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nmatrix done: ${join(matrixDir, "index.md")}`);
  } finally { watch?.stop(); }
}

/** No app launch or backend: the existing XCUITest handshake is the automation probe. */
export async function automationPreflight(driver: Pick<PhoneDriver, "start" | "stop">, dir: string): Promise<boolean> {
  try { await driver.start(); return true; }
  catch (error) {
    const message = (error as Error).message;
    const remedy = message.includes(UI_AUTOMATION_OFF) ? `\n\n${UI_AUTOMATION_REMEDY}` : "";
    writeFileSync(join(dir, "summary.md"), `# Matrix preflight failed\n\n${message}${remedy}\n`);
    writeFileSync(join(dir, "run.log"), `ABORTED: ${message}\n`);
    console.error(message);
    return false;
  } finally { await driver.stop(); }
}
