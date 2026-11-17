/**
 * Optional model-graded reply check (`run --judge`, off by default).
 *
 * The regex checks (a step's expectWords / forbidWords, a screen checkpoint's
 * label patterns) fail on wording, not behaviour: a regex demanding
 * "Sheet-Pan" when whisper wrote "sheet pan", a timer-label pattern that is
 * not how the app labels a clock, "side" heard as "sight", "oregano" heard as
 * "or egg it out" (2026-11-12 device runs). One Claude call per run reads every
 * expectation with what was heard (and the screen labels for a screen check)
 * and says whether the app did what the step expected.
 *
 * How verdicts combine (regexes stay as the fallback):
 *   - judge pass, regex failed  -> the regex check becomes "warn" (detail says the judge passed it)
 *   - judge fail                -> a failing judge#<step> check (also when the regex passed)
 *   - judge unclear, or no judge (off, no key, an error) -> the regex verdict stands
 * Cost is recorded on the report (`judge.costUsd`) and in summary.md.
 */
import type { CheckResult } from "./assertions.ts";

export const JUDGE_MODEL = "claude-sonnet-5-5";
/** $ per million tokens for claude-sonnet-5-5 (input, output, cache write, cache read). */
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };

export interface JudgeItem {
  /** Stable id: "reply#<step>", "forbid#<step>", "screen#<step>". */
  id: string;
  kind: "reply" | "forbid" | "screen";
  step: number;
  /** What the robot said on that step (or the UI step name). */
  line?: string;
  /** What the step expected, in words: the step's `judge` text, else derived from the regex. */
  expectation: string;
  /** The regex the step used (context for the judge, and the fallback). */
  pattern: string;
  /** The app's reply as the Mac heard it (local whisper; may contain mishearings). */
  heard?: string;
  /** The screen's accessible labels at the failed check. */
  labels?: string[];
  /** Check id this item can override. */
  regexCheckId: string;
  /** For screen items: the ui-step check detail it matches. */
  regexDetail?: string;
}

export interface JudgeVerdict { id: string; verdict: "pass" | "fail" | "unclear"; reason: string }
export interface JudgeResult {
  model: string; verdicts: JudgeVerdict[]; costUsd: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  error?: string; items: number;
}

interface StepLike { ui?: string; say?: string; expectWords?: string; forbidWords?: string; judge?: string; judgeForbid?: string }
interface TurnLike { index: number; replyTranscript?: string }

/** Every expectation in a run that a judge can grade. */
export function collectJudgeItems(input: { steps: StepLike[]; turns: TurnLike[]; checks: CheckResult[]; screenChecks?: Record<string, { judge?: string }> }): JudgeItem[] {
  const items: JudgeItem[] = [];
  input.steps.forEach((step, i) => {
    const n = i + 1;
    const heard = input.turns.find((t) => t.index === n)?.replyTranscript;
    const line = step.say ?? step.ui;
    if (step.expectWords && heard !== undefined) items.push({ id: `reply#${n}`, kind: "reply", step: n, line, pattern: step.expectWords, heard, regexCheckId: `reply-words#${n}`,
      expectation: step.judge ?? `The reply does what this pattern was written to detect: /${step.expectWords}/ (the intent, not the exact spelling).` });
    if (step.forbidWords && heard !== undefined) items.push({ id: `forbid#${n}`, kind: "forbid", step: n, line, pattern: step.forbidWords, heard, regexCheckId: `reply-not-words#${n}`,
      expectation: step.judgeForbid ?? `The reply must NOT do what this pattern was written to catch: /${step.forbidWords}/. Pass when the reply does not do that thing.` });
  });
  // A failed screen checkpoint: "check:<key>: <key>: missing /re/; labels: [...]".
  for (const check of input.checks) {
    if (check.id !== "ui-step" || check.verdict !== "fail") continue;
    const m = /^check:([^:]+): (.*?); labels: (\[.*\])$/s.exec(check.detail);
    if (!m) continue;
    let labels: string[];
    try { labels = JSON.parse(m[3]); } catch { continue; }
    const stepIndex = input.steps.findIndex((s) => s.ui === `check:${m[1]}`) + 1;
    const custom = input.screenChecks?.[m[1]]?.judge;
    items.push({ id: `screen#${stepIndex || m[1]}`, kind: "screen", step: stepIndex, line: `check:${m[1]}`, pattern: m[2], labels, regexCheckId: "ui-step", regexDetail: check.detail,
      expectation: custom ?? `The screen shows what this checkpoint was written to verify; the pattern that failed: ${m[2]}. Judge the intent (e.g. one running timer, a named timer), not the exact label text.` });
  }
  return items;
}

const SYSTEM = `You grade a scripted voice test of a phone app. A robot speaks lines to the app; the Mac transcribes the app's spoken replies with a small local speech recognizer, and reads the app's on-screen accessibility labels.

For each item, decide whether the app did what the step expected.
- Judge meaning and behaviour, never spelling, capitalization, hyphenation or punctuation ("sheet pan" = "Sheet-Pan").
- The transcript is a local recognizer's guess and contains mishearings of near-sounding words ("sight" may be "side", "or egg it out" may be "oregano", "time" may be "thyme"). Read it charitably as speech, the way a person in the room would have heard it.
- For screen items, the labels are the app's real accessible names; the app may label a timer by its own name for the food or step ("Boil spaghetti: 8:12 left" can be the pasta timer). Judge whether the screen state matches the intent.
- "pass": clearly did what was expected (or, for a "must NOT" item, clearly did not do the forbidden thing).
- "fail": clearly did not (or did the forbidden thing).
- "unclear": the evidence cannot decide (empty or garbled transcript, missing labels).
Give a one-sentence reason quoting the decisive words.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["verdicts"],
  properties: { verdicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "verdict", "reason"],
    properties: { id: { type: "string" }, verdict: { type: "string", enum: ["pass", "fail", "unclear"] }, reason: { type: "string" } } } } },
};

/** The minimal client surface used (the Anthropic SDK's beta messages API); injectable for tests. */
export interface JudgeClient {
  beta: { messages: { create(body: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }>; stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }> } };
}

export function judgeCostUsd(usage: NonNullable<JudgeResult["usage"]>): number {
  return (usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output + usage.cacheWriteTokens * PRICE.cacheWrite + usage.cacheReadTokens * PRICE.cacheRead) / 1e6;
}

export async function runJudge(items: JudgeItem[], context: { scenario: string; description?: string }, options: { client?: JudgeClient; apiKey?: string } = {}): Promise<JudgeResult> {
  const base = { model: JUDGE_MODEL, verdicts: [] as JudgeVerdict[], costUsd: 0, items: items.length };
  if (!items.length) return base;
  let client = options.client;
  if (!client) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ...base, error: "no ANTHROPIC_API_KEY (regex checks stand)" };
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ apiKey, timeout: 120000, maxRetries: 2 }) as unknown as JudgeClient;
    } catch (error) { return { ...base, error: `@anthropic-ai/sdk is not installed (${(error as Error).message}); regex checks stand` }; }
  }
  const payload = items.map((it) => ({ id: it.id, kind: it.kind, step: it.step, robotSaid: it.line, expectation: it.expectation,
    ...(it.heard !== undefined ? { appReplyHeard: it.heard } : {}), ...(it.labels ? { screenLabels: it.labels } : {}) }));
  try {
    const response = await client.beta.messages.create({
      model: JUDGE_MODEL, max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Scenario ${context.scenario}: ${context.description ?? ""}\n\nItems:\n${JSON.stringify(payload, null, 1)}\n\nReturn one verdict per item id.` }],
    });
    const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0, cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0 };
    const costUsd = judgeCostUsd(usage);
    if (response.stop_reason === "refusal") return { ...base, usage, costUsd, error: "the judge declined (refusal); regex checks stand" };
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { verdicts?: JudgeVerdict[] };
    const known = new Set(items.map((i) => i.id));
    const verdicts = (parsed.verdicts ?? []).filter((v) => known.has(v.id) && ["pass", "fail", "unclear"].includes(v.verdict));
    return { ...base, usage, costUsd, verdicts };
  } catch (error) {
    return { ...base, error: `judge call failed: ${(error as Error).message.slice(0, 200)}; regex checks stand` };
  }
}

/** Fold judge verdicts into the run's checks (see the header for the rules). */
export function applyJudge(checks: CheckResult[], items: JudgeItem[], result: JudgeResult): CheckResult[] {
  const out = checks.map((c) => ({ ...c }));
  if (result.error) { out.push({ id: "model-judge", source: "judge", verdict: "unmeasured", detail: result.error }); return out; }
  const byId = new Map(result.verdicts.map((v) => [v.id, v]));
  for (const item of items) {
    const v = byId.get(item.id);
    const regex = out.find((c) => c.id === item.regexCheckId && (item.regexDetail === undefined || c.detail === item.regexDetail));
    if (!v) { out.push({ id: `judge#${item.step || item.id}:${item.kind}`, source: "judge", verdict: "unmeasured", detail: "no verdict returned; regex check stands" }); continue; }
    if (v.verdict === "unclear") { out.push({ id: `judge#${item.step}:${item.kind}`, source: "judge", verdict: "warn", detail: `unclear: ${v.reason}; regex check stands` }); continue; }
    if (v.verdict === "pass" && regex?.verdict === "fail") { regex.verdict = "warn"; regex.detail = `regex missed, model judge passed (${v.reason}); was: ${regex.detail}`; }
    out.push({ id: `judge#${item.step}:${item.kind}`, source: "judge", verdict: v.verdict, detail: `${v.reason} [${item.expectation.slice(0, 100)}]` });
  }
  out.push({ id: "model-judge", source: "judge", verdict: "pass", detail: `${result.verdicts.length} of ${items.length} item(s) graded by ${result.model}, $${result.costUsd.toFixed(4)}` });
  return out;
}
