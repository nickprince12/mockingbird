import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { AutomationWatch, automationEvent, UI_AUTOMATION_REMEDY } from "../src/core/automationWatch.ts";

test("automation log lines are classified", () => {
  assert.equal(automationEvent("testmanagerd[123]: Automation Mode has been disabled, existing connections will be invalidated."), "disabled");
  assert.equal(automationEvent("Rejecting automation session connection because Automation Mode is not enabled"), "rejected");
  assert.equal(automationEvent("Setting AutomationEnabled in preparation for UI testing"), "enabled");
  assert.equal(automationEvent("unrelated"), "other");
  assert.match(UI_AUTOMATION_REMEDY, /Enable UI Automation/);
});

test("the watch writes phone lines and rig marks to one timeline, split chunks included", () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-"));
  try {
    const file = join(dir, "automation-mode.log");
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
    const spawned: string[][] = [];
    const watch = new AutomationWatch("00008110-ABC", file, ((cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return child; }) as never);
    assert.equal(watch.start(), true);
    assert.deepEqual(spawned[0].slice(0, 3), ["idevicesyslog", "-u", "00008110-ABC"]);
    watch.mark("arm start s / a");
    child.stdout.emit("data", "Nov 12 testmanagerd: Automation Mode has been dis");
    child.stdout.emit("data", "abled, existing connections will be invalidated.\n");
    watch.stop();
    const log = readFileSync(file, "utf8");
    assert.match(log, /RIG watch started/);
    assert.match(log, /RIG arm start s \/ a/);
    assert.match(log, /DISABLED Nov 12 testmanagerd: Automation Mode has been disabled/);
    assert.equal(watch.events.length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});
