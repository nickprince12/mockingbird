import { test } from "node:test";
import assert from "node:assert/strict";
import { applyJudge, collectJudgeItems, judgeCostUsd, runJudge, JUDGE_MODEL, type JudgeClient } from "../src/core/judge.ts";
import { summary } from "../src/run.ts";

// Synthetic examples of three false-positive classes.
const steps = [
  { ui: "startVoice" },
  { await: "first-words", expectWords: "Desk-Lamp" },
  { say: "The blue lamp and ceiling light are both on.", expectWords: "(?=.*lamp)(?=.*ceiling)" },
  { say: "Which side moves first?", expectWords: "side", forbidWords: "start (?:over|again)" },
  { ui: "check:twoTimers" },
];
const turns = [
  { index: 2, replyTranscript: "The desk lamp is ready." },
  { index: 3, replyTranscript: "The blue lamp and sealing light are both on." },
  { index: 4, replyTranscript: "Left sight moves first." },
];
const screenDetail = `check:twoTimers: twoTimers: missing /main room:\\s*\\d+(?::\\d{2}){1,2} left/; labels: ${JSON.stringify(["Active timers", "Main room timer: 8:12 left", "Hallway timer: 4:00 left"])}`;
const checks = [
  { id: "reply-words#2", source: "acoustic", verdict: "fail" as const, detail: "did not match /Desk-Lamp/" },
  { id: "reply-words#3", source: "acoustic", verdict: "fail" as const, detail: "did not match" },
  { id: "reply-words#4", source: "acoustic", verdict: "fail" as const, detail: "did not match /side/" },
  { id: "reply-not-words#4", source: "acoustic", verdict: "pass" as const, detail: "no match" },
  { id: "ui-step", source: "screen", verdict: "fail" as const, detail: screenDetail },
];

test("judge items cover expectWords, forbidWords and failed screen checkpoints", () => {
  const items = collectJudgeItems({ steps: steps as never, turns, checks, screenChecks: { twoTimers: { judge: "Two timers run: one for the main room, one for the hallway." } } });
  assert.deepEqual(items.map((i) => i.id), ["reply#2", "reply#3", "reply#4", "forbid#4", "screen#5"]);
  const screen = items.find((i) => i.kind === "screen")!;
  assert.deepEqual(screen.labels, ["Active timers", "Main room timer: 8:12 left", "Hallway timer: 4:00 left"]);
  assert.equal(screen.expectation, "Two timers run: one for the main room, one for the hallway.");
  assert.match(items[0].expectation, /Desk-Lamp/);
});

function fakeClient(verdicts: object[], capture: Record<string, unknown>[] = []): JudgeClient {
  return { beta: { messages: { create: async (body) => { capture.push(body); return {
    content: [{ type: "text", text: JSON.stringify({ verdicts }) }], stop_reason: "end_turn",
    usage: { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; } } } };
}

test("judge passes downgrade false-positive regex failures to warn; cost is recorded", async () => {
  const items = collectJudgeItems({ steps: steps as never, turns, checks });
  const sent: Record<string, unknown>[] = [];
  const result = await runJudge(items, { scenario: "s", description: "d" }, { client: fakeClient([
    { id: "reply#2", verdict: "pass", reason: "names the desk lamp" },
    { id: "reply#3", verdict: "pass", reason: "'sealing' is 'ceiling'" },
    { id: "reply#4", verdict: "pass", reason: "'sight' is 'side'" },
    { id: "forbid#4", verdict: "pass", reason: "no restart" },
    { id: "screen#5", verdict: "pass", reason: "Main room timer is the requested timer" },
    { id: "bogus", verdict: "fail", reason: "ignored" },
  ], sent) });
  assert.equal(sent.length, 1, "one call per run");
  assert.equal(sent[0].model, JUDGE_MODEL);
  assert.equal(result.verdicts.length, 5);
  assert.equal(result.costUsd, judgeCostUsd({ inputTokens: 1500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  assert.ok(Math.abs(result.costUsd - 0.007) < 1e-9);
  const out = applyJudge(checks, items, result);
  assert.equal(out.filter((c) => c.verdict === "fail").length, 0);
  for (const id of ["reply-words#2", "reply-words#3", "reply-words#4"]) assert.equal(out.find((c) => c.id === id)!.verdict, "warn");
  assert.equal(out.find((c) => c.id === "ui-step")!.verdict, "warn");
  assert.match(out.find((c) => c.id === "model-judge")!.detail, /5 of 5 .*\$0\.0070/);
  assert.equal(checks[0].verdict, "fail", "input checks are not mutated");
});

test("judge fail stands even when the regex passed; unclear leaves the regex verdict", async () => {
  const items = collectJudgeItems({ steps: steps as never, turns, checks });
  const result = await runJudge(items, { scenario: "s" }, { client: fakeClient([
    { id: "reply#2", verdict: "unclear", reason: "garbled" },
    { id: "forbid#4", verdict: "fail", reason: "it restarted" },
  ]) });
  const out = applyJudge(checks, items, result);
  assert.equal(out.find((c) => c.id === "reply-words#2")!.verdict, "fail");
  assert.equal(out.find((c) => c.id === "judge#2:reply")!.verdict, "warn");
  assert.equal(out.find((c) => c.id === "judge#4:forbid")!.verdict, "fail");
  assert.equal(out.find((c) => c.id === "judge#3:reply")!.verdict, "unmeasured");
});

test("no key or a failing call leaves every regex verdict and says why", async () => {
  const items = collectJudgeItems({ steps: steps as never, turns, checks });
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const none = await runJudge(items, { scenario: "s" });
    assert.match(none.error!, /no ANTHROPIC_API_KEY/);
    const out = applyJudge(checks, items, none);
    assert.deepEqual(out.slice(0, checks.length), checks);
    assert.equal(out.at(-1)!.verdict, "unmeasured");
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  const broken = await runJudge(items, { scenario: "s" }, { client: { beta: { messages: { create: async () => { throw new Error("529 overloaded"); } } } } });
  assert.match(broken.error!, /529 overloaded/);
  assert.equal((await runJudge([], { scenario: "s" })).error, undefined, "nothing to grade, no call");
});

test("summary.md carries the backend trace section, judge cost and health", () => {
  const report = { app: "example", scenario: "s", verdict: "PASS", simulator: false, device: "d", startedAt: "t", spendUsd: 0, budgetUsd: 1,
    backend: { assistant: [] }, judge: { model: JUDGE_MODEL, costUsd: 0.0071 }, health: { health: "ok", reasons: [] } };
  const md = summary(report, [], [], { title: "Backend trace (new-engine turn timing)", markdown: "| turn |\n|---|\n| 1 |" });
  assert.match(md, /Model judge \(claude-sonnet-5-5\): \$0\.0071/);
  assert.match(md, /Health: ok\./);
  assert.match(md, /## Backend trace \(new-engine turn timing\)\n\n\| turn \|/);
  assert.match(summary(report, [], [], undefined, "HTTP 503"), /## Backend trace\n\nUnavailable: HTTP 503/);
});
