/**
 * `mockingbird probe --adapter <adapter.ts> | --bundle <id> --device sim [--launch] [--tap "<label>"]...`
 * Starts the phone driver, optionally launches the app and taps labels, then
 * prints every accessible label on screen and saves a screenshot. The fastest
 * way to see what the driver sees when a scenario step cannot find something.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PhoneDriver } from "./core/driver.ts";
import { loadAdapter } from "./adapters.ts";

const argv = process.argv.slice(2);
const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const outDir = resolve(value("--out") ?? join(process.cwd(), "reports/mockingbird/probe"));
mkdirSync(outDir, { recursive: true });
const adapter = value("--adapter") ? await loadAdapter(value("--adapter")) : undefined;
const bundleId = value("--bundle") ?? adapter?.bundleId;
if (!bundleId) throw new Error("probe needs --adapter <adapter.ts> or --bundle <bundle id>");
const driver = new PhoneDriver({ device: value("--device") ?? "sim", bundleId,
  derivedDataPath: value("--derived-data") ?? join(tmpdir(), "mockingbird-dd"), logFile: join(outDir, "xcodebuild.log"),
  developmentTeam: value("--team") ?? process.env.MOCKINGBIRD_DEVELOPMENT_TEAM ?? adapter?.developmentTeam?.(),
  transport: argv.includes("--poll") || process.env.MOCKINGBIRD_TRANSPORT === "poll" ? "poll" : argv.includes("--usb") || process.env.MOCKINGBIRD_TRANSPORT === "usb" ? "usb" : "auto" });
// --backend: also start the adapter's backend (if it has one).
if (driver.simulator) adapter?.prepareSimulator?.(driver.udid);
const backend = argv.includes("--backend") && adapter?.startBackend ? await adapter.startBackend(outDir, { budgetUsd: 0.5, scenario: {}, simulator: driver.simulator }) : undefined;
if (backend) console.log("backend:", backend.describe);
await driver.start();
console.log("driver:", JSON.stringify(driver.info));
try {
  if (argv.includes("--launch")) console.log("launch:", (await driver.run("launch", { timeout: 20 })).value);
  await driver.run("allowSystemAlerts", { timeout: 2 }, { allowFail: true });
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tap" || argv[i] === "--tap-exact") {
      const target = argv[i] === "--tap" ? { contains: argv[i + 1] } : { label: argv[i + 1] };
      console.log("tap:", JSON.stringify((await driver.run("tap", { ...target, timeout: 10 }, { allowFail: true }))));
      if (argv.includes("--dump-each")) { await new Promise((r) => setTimeout(r, 800)); console.log((await driver.texts()).filter((t) => t.type !== "other").map((t) => `  ${t.type} ${t.label}${t.value && t.value !== t.label ? ` = ${t.value}` : ""}`).join("\n")); }
    }
    if (argv[i] === "--type") { const [field, text] = argv[i + 1].split("="); console.log("type:", JSON.stringify(await driver.run("typeText", { contains: field, text, timeout: 10, submit: argv.includes("--submit"), clear: true }, { allowFail: true }))); }
    if (argv[i] === "--find") { const [type, contains] = argv[i + 1].split(":"); console.log("find:", JSON.stringify(await driver.run("waitFor", { type, contains, timeout: 5 }, { allowFail: true }))); }
    if (argv[i] === "--tap-at") { const [x, y] = argv[i + 1].split(",").map(Number); console.log("tapAt:", JSON.stringify(await driver.run("tapAt", { x, y }, { allowFail: true }))); }
    if (argv[i] === "--shot") { const file = join(outDir, `${argv[i + 1]}.png`); await driver.screenshot(file); console.log("shot:", file); }
    if (argv[i] === "--dump") console.log((await driver.texts()).filter((t) => t.type !== "other").map((t) => `  ${t.y ?? ""} ${t.type} ${t.label}`).join("\n"));
    if (argv[i] === "--wait") await new Promise((r) => setTimeout(r, Number(argv[i + 1]) * 1000));
  }
  for (const t of await driver.texts()) console.log(`${String(t.y ?? "").padStart(4)} ${t.type.padEnd(7)} ${t.label}${t.value ? ` = ${t.value}` : ""}`);
  await driver.screenshot(join(outDir, "screen.png"));
  console.log("screenshot:", join(outDir, "screen.png"));
} finally { await driver.stop(); await backend?.stop(); }
