import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyHealth, classifyRunDir, countUnanswered, healthLine } from "../src/core/health.ts";
import { main as matrixMain, passthrough } from "../src/matrix.ts";
import { UI_AUTOMATION_OFF, UI_AUTOMATION_OFF_LEGACY } from "../src/core/driver.ts";
import { UI_AUTOMATION_REMEDY } from "../src/core/automationWatch.ts";

const pass = (id: string) => ({ id, verdict: "pass", source: "x", detail: "ok" });
const fail = (id: string, detail = "bad") => ({ id, verdict: "fail", source: "x", detail });

test("health: a clean run is ok, a failed check is a product failure", () => {
  assert.equal(classifyHealth({ checks: [pass("first-words")] }).health, "ok");
  const h = classifyHealth({ checks: [pass("first-words"), fail("reply-words#5"), fail("run-completed", "the app is not listening (on Hold) before \"Done\"")] });
  assert.equal(h.health, "product-fail");
  assert.match(h.reasons.join(), /run stopped: the app is not listening/);
  assert.deepEqual(h.failedChecks, ["reply-words#5", "run-completed"]);
});

test("health: infrastructure failures from the external watchdog's patterns", () => {
  assert.equal(classifyHealth({ checks: [fail("first-words", "no first words heard")] }).health, "infra");
  assert.equal(classifyHealth({ checks: [fail("engine-admission", "the app fell back to Live: live (http-429)")] }).health, "infra");
  assert.equal(classifyHealth({ checks: [fail("run-completed", "ensureReady: Example never reached Home (walked: )")] }).health, "infra");
  assert.equal(classifyHealth({ checks: [fail("run-completed", "xcodebuild exited 65 before the driver connected; see x")] }).health, "infra");
  assert.equal(classifyHealth({ checks: [fail("run-completed", UI_AUTOMATION_OFF)] }).health, "infra");
  assert.equal(classifyHealth({ checks: [], runLog: "ABORTED: Timed out while enabling automation mode" }).health, "infra");
  assert.equal(classifyHealth({ missingReport: "no report" }).health, "infra");
  // A slow first answer is a product failure, not "no first words".
  assert.equal(classifyHealth({ checks: [fail("first-words", "12.0 s from voice start to first heard words")] }).health, "product-fail");
  // Plain "ui ensureReady" in the log is a step name, not a failure.
  assert.equal(classifyHealth({ checks: [pass("first-words")], runLog: "10:00 ui ensureReady\n10:01 ready after: nothing" }).health, "ok");
});

test("health: 4+ unanswered lines are infrastructure, fewer are product", () => {
  const detail = (n: number) => `no reply to: ${Array.from({ length: n }, (_, i) => `"line, ${i}"`).join(", ")}`;
  assert.equal(countUnanswered(detail(3)), 3);
  assert.equal(classifyHealth({ checks: [fail("every-utterance-answered", detail(3))] }).health, "product-fail");
  assert.equal(classifyHealth({ checks: [fail("every-utterance-answered", detail(4))] }).health, "infra");
  assert.equal(classifyHealth({ checks: [fail("every-utterance-answered", detail(4))] }, { unansweredInfraAt: 6 }).health, "product-fail");
});

test("health: old run folders classify from summary.md alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  try {
    writeFileSync(join(dir, "summary.md"), "| FAIL | engine-admission | app-record | the app fell back to Live |\n");
    assert.equal(classifyRunDir(dir).health, "infra");
    assert.equal(classifyRunDir(join(dir, "missing"), 1).health, "infra");
  } finally { rmSync(dir, { recursive: true }); }
});

test("health line is one concise line", () => {
  const line = healthLine("[2/4] engine-pace / cascade-sonnet", { health: "product-fail", reasons: ["2 check(s) failed"], failedChecks: ["a", "b"], firstWordsMs: 4100 });
  assert.equal(line.includes("\n"), false);
  assert.match(line, /PRODUCT-FAIL .*first words 4\.1 s.*2 failed: a, b/);
});

test("matrix flags stay out of the per-run options", () => {
  assert.deepEqual(passthrough(["--arms", "x", "--keep-going", "--unanswered-infra", "5", "--watch-automation", "--device", "d"]), ["--device", "d"]);
});

function fakeMatrix(outcomes: Record<string, object[]>) {
  const root = mkdtempSync(join(tmpdir(), "matrix-"));
  const arms = join(root, "arms.json");
  writeFileSync(arms, JSON.stringify({ id: "t", arms: Object.keys(outcomes).map((id) => ({ id })) }));
  const calls: string[] = [];
  const runArm = (args: string[]) => {
    const arm = JSON.parse(args[args.indexOf("--arm") + 1]).id as string;
    const scenario = args[args.indexOf("--scenario") + 1];
    calls.push(`${scenario}/${arm}`);
    const dir = join(args[args.indexOf("--reports") + 1], `run-${arm}`);
    mkdirSync(dir, { recursive: true });
    const checks = outcomes[arm];
    writeFileSync(join(dir, "report.json"), JSON.stringify({ verdict: checks.some((c: any) => c.verdict === "fail") ? "FAIL" : "PASS", scenario, arm: { id: arm }, startedAt: "x", checks, turns: [] }));
    writeFileSync(join(dir, "run.log"), "log\n");
    return { status: 1 };
  };
  return { root, arms, calls, runArm };
}

test("matrix: a product failure keeps going, an infrastructure failure aborts the rest", async () => {
  const f = fakeMatrix({ a: [pass("first-words"), fail("reply-words#3")], b: [fail("first-words", "no first words heard")], c: [pass("first-words")] });
  const before = process.exitCode;
  try {
    await matrixMain(["--arms", f.arms, "--scenario", "s1,s2", "--reports", f.root], { runArm: f.runArm, preflight: async () => true, pauseMs: 0 });
    assert.deepEqual(f.calls, ["s1/a", "s1/b"], "c and all of s2 never start");
    assert.equal(process.exitCode, 1);
    const matrixDir = join(f.root, readdirSync(f.root).find((d) => d.includes("-matrix-t"))!);
    const log = readFileSync(join(matrixDir, "health.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /\[1\/6\] s1 \/ a  PRODUCT-FAIL/);
    assert.match(log[1], /\[2\/6\] s1 \/ b  INFRA-FAIL  no first words/);
    assert.match(readFileSync(join(matrixDir, "summary.md"), "utf8"), /Matrix aborted[\s\S]*4 arm run\(s\) not started/);
    assert.match(readFileSync(join(matrixDir, "index.md"), "utf8"), /\*\*Aborted\*\*/);
    assert.equal(JSON.parse(readFileSync(join(matrixDir, "health.json"), "utf8")).length, 2);
  } finally { process.exitCode = before; rmSync(f.root, { recursive: true }); }
});

test("matrix: --keep-going runs every arm despite infrastructure failures", async () => {
  const f = fakeMatrix({ a: [fail("engine-admission", "fell back")], b: [pass("first-words")] });
  const before = process.exitCode;
  try {
    await matrixMain(["--arms", f.arms, "--scenario", "s1", "--reports", f.root, "--keep-going"], { runArm: f.runArm, preflight: async () => true, pauseMs: 0 });
    assert.deepEqual(f.calls, ["s1/a", "s1/b"]);
    const matrixDir = join(f.root, readdirSync(f.root).find((d) => d.includes("-matrix-t"))!);
    assert.equal(existsSync(join(matrixDir, "summary.md")), false);
    assert.match(readFileSync(join(matrixDir, "index.md"), "utf8"), /INFRA-FAIL: not admitted/);
  } finally { process.exitCode = before; rmSync(f.root, { recursive: true }); }
});

test("matrix: a failed preflight starts no arm", async () => {
  const f = fakeMatrix({ a: [pass("first-words")] });
  const before = process.exitCode;
  try {
    await matrixMain(["--arms", f.arms, "--scenario", "s1", "--reports", f.root], { runArm: f.runArm, preflight: async () => false, pauseMs: 0 });
    assert.deepEqual(f.calls, []);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = before; rmSync(f.root, { recursive: true }); }
});

test("automation timeout: the message names the passcode sheet; old and new logs both classify", () => {
  assert.match(UI_AUTOMATION_OFF, /asking for its passcode to enable UI Automation for XCTest; enter it on the phone/);
  assert.match(UI_AUTOMATION_OFF, /toggle Settings > Developer > Enable UI Automation off and on/);
  assert.match(UI_AUTOMATION_REMEDY, /Enter iPhone Passcode for/);
  assert.match(UI_AUTOMATION_REMEDY, /never does/);
  for (const text of [UI_AUTOMATION_OFF, UI_AUTOMATION_OFF_LEGACY, "Timed out while enabling automation mode"]) {
    const h = classifyHealth({ checks: [fail("run-completed", text)] });
    assert.equal(h.health, "infra");
    assert.match(h.reasons.join(), /passcode for XCTest/);
  }
  assert.equal(classifyHealth({ checks: [pass("first-words")], runLog: "runner build reused (iphoneos, driver sources unchanged since x)" }).health, "ok");
});

test('matrix comparison child runs forward both quiet flags to run.ts argv policy', async () => {
  const { quietTarget } = await import('../src/core/runOptions.ts');
  for (const flags of [['--quiet-target'], ['--no-quiet-target'], ['--quiet-target', '--no-quiet-target']]) {
    const f = fakeMatrix({ a: [pass('first-words')] });
    const before = process.exitCode;
    try {
      let seen = false;
      await matrixMain(['--arms', f.arms, '--scenario', 's1', '--reports', f.root, ...flags], {
        preflight: async () => true, pauseMs: 0,
        runArm: args => {
          seen = true;
          assert.equal(args[0], 'run');
          for (const flag of flags) assert.ok(args.includes(flag));
          // run.ts reads process.argv (node, cli.ts, run, ...child args),
          // using includes, so neither boolean flag consumes the next option.
          const argv = ['node', 'cli.ts', ...args];
          assert.equal(quietTarget(false, true, argv, ''), !flags.includes('--no-quiet-target'));
          return f.runArm(args);
        }
      });
      assert.ok(seen);
    } finally { process.exitCode = before; rmSync(f.root, { recursive: true, force: true }); }
  }
});
