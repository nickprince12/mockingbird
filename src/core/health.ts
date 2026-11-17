/**
 * Run health: is a finished run's verdict about the APP (a product failure,
 * worth reading and moving on) or about the RIG (an infrastructure failure:
 * every later arm would fail the same way, so stop the matrix)?
 *
 * Infrastructure (abort the matrix):
 *   - no first words at all (the voice never reached the Mac mic, or never started)
 *   - engine-admission failed (the app silently ran another engine; later arms
 *     would compare nothing)
 *   - the driver could not start or a setup step failed: xcodebuild exited,
 *     the driver never connected, UI Automation is off, ensureReady failed
 *   - many lines unanswered (4+ by default): the phone is not hearing the speaker
 *   - no report at all (the run process crashed)
 * Product (report, keep going): run-completed failed for another reason, or
 * any other failed check.
 *
 * Replaces an external watchdog that grepped each run's summary.md
 * (2026-11-12). Reads report.json when there is one; summary.md and run.log
 * text are a fallback, so old run folders classify too.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_AUTOMATION_OFF, UI_AUTOMATION_OFF_LEGACY } from "./driver.ts";

export type Health = "ok" | "product-fail" | "infra";
export interface RunHealth { health: Health; reasons: string[]; failedChecks: string[]; firstWordsMs?: number }

interface CheckLike { id: string; verdict: string; detail: string }
export interface HealthInput { checks?: CheckLike[]; startToFirstWordsMs?: number; runLog?: string; summary?: string; missingReport?: string }

const AUTOMATION_REASON = "automation mode timed out (the phone is probably asking for its passcode for XCTest)";
/** Lines that mean the rig itself, not the app, failed. */
const infraText: Array<[RegExp, string]> = [
  [/INFRA:.*(?:installed app|expected build)/i, "installed app build check failed"],
  ...[UI_AUTOMATION_OFF, UI_AUTOMATION_OFF_LEGACY].map((m): [RegExp, string] => [new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), AUTOMATION_REASON]),
  [/Timed out while enabling automation mode/i, AUTOMATION_REASON],
  [/xcodebuild exited/i, "xcodebuild exited (driver build or launch failed)"],
  [/driver did not connect|before the driver (connected|listened)/i, "the phone driver never connected"],
  [/\bensureReady:/, "ensureReady failed (the app never reached Home)"],
  [/Matrix preflight failed/i, "matrix preflight failed"],
];

export function classifyHealth(input: HealthInput, options: { unansweredInfraAt?: number } = {}): RunHealth {
  if (/budget-stop/.test([input.runLog, input.summary, ...(input.checks ?? []).map(c => c.detail)].join('\n'))) return { health: 'infra', reasons: ['budget-stop'], failedChecks: [] };
  const reasons: string[] = [];
  if (input.missingReport) return { health: "infra", reasons: [input.missingReport], failedChecks: [] };
  const checks = input.checks ?? [];
  const failed = checks.filter((c) => c.verdict === "fail");
  const failedChecks = failed.map((c) => c.id);
  const text = [input.runLog ?? "", input.summary ?? "", ...failed.map((c) => c.detail)].join("\n");

  const spokeOver = checks.filter(c => c.id.startsWith('spoke-over-app#') && c.verdict === 'fail');
  if (spokeOver.length) {
    const product = failed.filter(c => !c.id.startsWith('spoke-over-app#') && !['played-not-heard', 'engine-admission'].includes(c.id) && !(c.id === 'first-words' && /no first words/i.test(c.detail)) && !infraText.some(([pattern]) => pattern.test(c.detail)));
    return { health: product.length ? 'product-fail' : 'infra', reasons: [...(product.length ? [`${product.length} product check(s) failed: ${product.map(c => c.id).join(', ')}`] : []), `spoke-over-app: ${spokeOver.length} overlapped lines without app transcripts`], failedChecks, firstWordsMs: input.startToFirstWordsMs };
  }
  const captureGap = checks.some(c => c.id === "played-not-heard" && c.verdict === "fail");
  const productSignal = failed.some(c => !['played-not-heard', 'first-words'].includes(c.id));
  const noWords = input.startToFirstWordsMs === undefined && checks.some(c => c.id === 'first-words' && c.verdict === 'fail' && /no first words/i.test(c.detail));
  if (captureGap && (productSignal || !noWords)) return { health: 'product-fail', reasons: ['played-not-heard: capture/detection gap; product checks retained'], failedChecks, firstWordsMs: input.startToFirstWordsMs };
  if (captureGap && noWords) reasons.push('played-not-heard (no first words and no other product failure)');
  const firstWords = checks.find((c) => c.id === "first-words");
  if (firstWords?.verdict === "fail" && /no first words/i.test(firstWords.detail)) reasons.push("no first words");
  else if (!checks.length && /FAIL \| first-words \| acoustic \| no first words/.test(text)) reasons.push("no first words");
  const admission = checks.find((c) => c.id === "engine-admission");
  if (admission?.verdict === "fail" || (!checks.length && /FAIL \| engine-admission/.test(text))) reasons.push(`not admitted to the requested engine${admission ? `: ${admission.detail.slice(0, 120)}` : ""}`);
  for (const [pattern, why] of infraText) if (pattern.test(text) && !reasons.includes(why)) reasons.push(why);
  const answered = checks.find((c) => c.id === "every-utterance-answered");
  const unansweredAt = options.unansweredInfraAt ?? 4;
  const dropped = answered?.verdict === "fail" ? countUnanswered(answered.detail) : 0;
  if (dropped >= unansweredAt) reasons.push(`${dropped} lines unanswered (the phone may not hear the speaker)`);

  if (reasons.length) return { health: "infra", reasons, failedChecks, firstWordsMs: input.startToFirstWordsMs };
  const completed = checks.find((c) => c.id === "run-completed");
  if (completed?.verdict === "fail") reasons.push(`run stopped: ${completed.detail.slice(0, 140)}`);
  if (failed.length) return { health: "product-fail", reasons: reasons.length ? reasons : [`${failed.length} check(s) failed`], failedChecks, firstWordsMs: input.startToFirstWordsMs };
  return { health: "ok", reasons: [], failedChecks, firstWordsMs: input.startToFirstWordsMs };
}

/** "no reply to: "a", "b", "c"" -> 3 */
export function countUnanswered(detail: string): number {
  const list = detail.match(/no reply to: (.*)$/)?.[1];
  if (!list) return 0;
  return (list.match(/"(?:[^"\\]|\\.)*"/g) ?? list.split(",")).length;
}

/** Classify a saved run folder (report.json, else summary.md + run.log). */
export function classifyRunDir(runDir: string | undefined, exit?: number | null, options?: { unansweredInfraAt?: number }): RunHealth {
  if (!runDir || !existsSync(runDir)) return classifyHealth({ missingReport: `no report (run process exit ${exit ?? "?"})` });
  const read = (name: string) => existsSync(join(runDir, name)) ? readFileSync(join(runDir, name), "utf8") : undefined;
  const reportText = read("report.json");
  let report: { checks?: CheckLike[]; startToFirstWordsMs?: number } | undefined;
  try { report = reportText ? JSON.parse(reportText) : undefined; } catch { report = undefined; }
  if (!report && !read("summary.md")) return classifyHealth({ missingReport: `no report (run process exit ${exit ?? "?"})` });
  return classifyHealth({ checks: report?.checks, startToFirstWordsMs: report?.startToFirstWordsMs, runLog: read("run.log"), summary: read("summary.md") }, options);
}

/** One concise line per arm, e.g. "[2/4] response-time / candidate  PRODUCT-FAIL  first words 4.1 s; 3 failed: ...". */
export function healthLine(label: string, h: RunHealth, extra = ""): string {
  const tag = { ok: "ok", "product-fail": "PRODUCT-FAIL", infra: "INFRA-FAIL" }[h.health];
  const fw = h.firstWordsMs !== undefined ? `first words ${(h.firstWordsMs / 1000).toFixed(1)} s` : "";
  const failed = h.failedChecks.length ? `${h.failedChecks.length} failed: ${h.failedChecks.slice(0, 6).join(", ")}${h.failedChecks.length > 6 ? ", …" : ""}` : "";
  const why = h.health === "ok" ? "" : h.reasons.join("; ");
  return `${label}  ${tag}  ${[fw, why, h.health === "infra" ? "" : failed, extra].filter(Boolean).join(" | ")}`.trimEnd();
}
