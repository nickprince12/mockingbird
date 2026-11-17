/**
 * "Timed out while enabling automation mode" on a test phone (2026-11-12:
 * clusters at ~02:15 and ~10:30-11:15, 60+ clean sessions between, no runner
 * rebuilds). The toggle was ON each time; the phone was showing iOS's sheet
 * 'Enter iPhone Passcode for "XCTest" - Enable UI Automation'. Apple documents
 * no interval. XCTest (testmanagerd) enables Automation Mode itself when a UI
 * test session starts, and asks for the passcode when the phone has one;
 * Apple engineers describe that re-authentication as needed "roughly once per
 * day" and CI users report "a few hours". No supported API re-enables it
 * remotely. See README "UI Automation keeps turning off".
 *
 * What this module does:
 *   - UI_AUTOMATION_REMEDY: the actionable text for a failed preflight.
 *   - AutomationWatch (`matrix --watch-automation`, devices, opt-in): runs
 *     `idevicesyslog -u <udid> -m "Automation Mode"` (libimobiledevice) for the
 *     whole matrix and writes each matching phone log line, timestamped, to
 *     <matrix>/automation-mode.log, next to the arm boundaries. That pins the
 *     actual trigger (time since enable, an install, a lock) instead of guessing.
 *     Read-only: it opens the phone's syslog relay, nothing else.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";

export const UI_AUTOMATION_REMEDY = [
  'Look at the test phone: iOS periodically shows "Enter iPhone Passcode for \"XCTest\" - Enable UI Automation"; a person enters the passcode there (the rig never does).',
  "If no sheet is showing, toggle Settings > Developer > Enable UI Automation off and on (or restart the phone).",
  "A test phone without a passcode is never asked (owner's call).",
].join(" ");

export type AutomationEvent = "disabled" | "enabled" | "rejected" | "other";

/** Classify one phone syslog line about Automation Mode. */
export function automationEvent(line: string): AutomationEvent {
  if (/Automation Mode has been disabled|automation mode (?:is )?disabled/i.test(line)) return "disabled";
  if (/Rejecting automation session|Automation Mode is not enabled/i.test(line)) return "rejected";
  if (/Setting AutomationEnabled|Automation Mode (?:has been )?enabled|enabling automation mode/i.test(line)) return "enabled";
  return "other";
}

export class AutomationWatch {
  private child?: ChildProcess;
  private tail = "";
  readonly events: Array<{ at: string; event: AutomationEvent; line: string }> = [];

  constructor(private readonly udid: string, private readonly logFile: string, private readonly spawnFn: typeof spawn = spawn) {}

  /** False (and a note in the log) when idevicesyslog is not installed. */
  start(): boolean {
    if (!this.spawnFn || (this.spawnFn === spawn && spawnSync("sh", ["-c", "command -v idevicesyslog"]).status !== 0)) {
      appendFileSync(this.logFile, `${new Date().toISOString()} watch not started: idevicesyslog not found (brew install libimobiledevice)\n`);
      return false;
    }
    this.child = this.spawnFn("idevicesyslog", ["-u", this.udid, "-m", "Automation Mode", "-m", "AutomationEnabled", "-m", "automation mode"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk) => this.feed(String(chunk)));
    this.child.on("error", (error) => appendFileSync(this.logFile, `${new Date().toISOString()} watch error: ${error.message}\n`));
    this.mark("watch started");
    return true;
  }

  feed(text: string) {
    const all = this.tail + text;
    const cut = all.lastIndexOf("\n");
    this.tail = all.slice(cut + 1);
    for (const line of all.slice(0, cut + 1).split("\n").filter(Boolean)) {
      const event = automationEvent(line);
      const at = new Date().toISOString();
      this.events.push({ at, event, line: line.slice(0, 400) });
      appendFileSync(this.logFile, `${at} ${event.toUpperCase()} ${line.slice(0, 400)}\n`);
    }
  }

  /** A rig event on the same timeline (arm start/end). */
  mark(what: string) { appendFileSync(this.logFile, `${new Date().toISOString()} RIG ${what}\n`); }

  stop() { this.child?.kill("SIGTERM"); this.child = undefined; }
}
