/**
 * Per-rig audio levels. The rule: the LOWEST levels that are still reliable,
 * plus one step of headroom, never "full volume". Keyed by Mac host, device
 * and route, because a different phone, route or room needs re-calibration.
 * Stored outside any repository: $MOCKINGBIRD_HOME/profiles.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface AudioProfile {
  /** macOS output volume (0-100) for the speaker that plays the user's lines. */
  macVolume?: number;
  /** The device's media volume target (0-1), enforced by the adapter's preflight. */
  deviceVolume?: number;
  /** Call-route calibration, separate from the unreadable media volume. Net
   * presses are relative to the first observed route, never an absolute slider. */
  callLevel?: { netPresses: number; presses: number; levelOverFloorDb: number; peakDb: number };
  route?: string;
  calibratedAt?: string;
  note?: string;
}

const home = () => process.env.MOCKINGBIRD_HOME ?? join(process.env.HOME ?? "", ".cache/mockingbird");
const file = () => join(home(), "profiles.json");
export const profileKey = (device: string, route = "speaker") => `${hostname().replace(/\.local$/, "")}|${device}|${route}`;

export function readProfile(key: string): AudioProfile | undefined {
  if (!existsSync(file())) return undefined;
  try { return (JSON.parse(readFileSync(file(), "utf8")) as Record<string, AudioProfile>)[key]; } catch { return undefined; }
}

export function saveProfile(key: string, profile: AudioProfile) {
  const all: Record<string, AudioProfile> = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
  all[key] = { ...all[key], ...profile, calibratedAt: new Date().toISOString() };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(all, null, 2));
}

/** The Mac's output volume (0-100), via AppleScript. */
export function macOutputVolume(): number {
  return Number(execFileSync("osascript", ["-e", "output volume of (get volume settings)"], { encoding: "utf8" }).trim());
}
export function setMacOutputVolume(volume: number) {
  execFileSync("osascript", ["-e", `set volume output volume ${Math.max(0, Math.min(100, Math.round(volume)))}`]);
}
