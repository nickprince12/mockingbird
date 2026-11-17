/**
 * Device hygiene before a run, generic for any app (adapters only choose).
 *
 * Route: the output must be one of the expected ports (default: the built-in
 * speaker) and no Bluetooth audio device may be connected unless the scenario
 * allows it. A phone still paired to someone's AirPods sends the app's voice
 * to the earbuds and lets an earbud event pause the session (first device
 * run, 2026-11-11).
 *
 * Volume: the device's media volume must sit at the calibrated target (the
 * lowest reliable level, within one of iOS's 16 steps) or, with no profile,
 * above a quick-estimate floor. Hardware presses are opt-in: in silence they
 * often change the ringer instead of media volume.
 */
import type { PhoneDriver } from "./driver.ts";
import type { AudioProfile } from "./profile.ts";

export interface DevicePreflightOptions {
  /** iOS port types allowed as output (AVAudioSession.Port raw values). */
  expectedOutputs?: string[];
  allowBluetooth?: boolean;
  profile?: AudioProfile;
  /** Floor used when no calibrated target exists (0-1). */
  quickFloor?: number;
  /** Press hardware volume-up to reach the floor/target. Only for dedicated devices. */
  pressVolume?: boolean;
  /** Skip the volume check (the volume is set later, during the app's speech). */
  skipVolume?: boolean;
  log?: (line: string) => void;
}

export interface DevicePreflightResult { outputs: string[]; volumeBefore: number; volumeAfter: number; target?: number }

export async function devicePreflight(driver: PhoneDriver, options: DevicePreflightOptions = {}): Promise<DevicePreflightResult> {
  const log = options.log ?? (() => undefined);
  const expected = options.expectedOutputs ?? ["Speaker"];
  const read = async () => (await driver.run("audioRoute", {})).value as { outputs: Array<{ type: string; name: string }>; availableInputs: Array<{ type: string; name: string }>; outputVolume: number };
  const route = await read();
  const outputs = route.outputs.map((o) => o.type);
  const bluetooth = route.availableInputs.filter((i) => /Bluetooth/i.test(i.type)).map((i) => i.name);
  log(`route: outputs ${outputs.join(", ") || "none"}; inputs available ${route.availableInputs.map((i) => i.type).join(", ")}; volume ${Math.round(route.outputVolume * 100)}%`);
  if (!outputs.length || !outputs.every((t) => expected.includes(t))) throw new Error(`audio output is ${outputs.join(", ") || "none"}, expected ${expected.join(" or ")}; disconnect headphones/Bluetooth first`);
  if (bluetooth.length && !options.allowBluetooth) throw new Error(`a Bluetooth audio device is connected (${bluetooth.join(", ")}); it can take the route or pause the session mid-run; disconnect it first`);

  if (options.skipVolume) { log("volume: set during the app's speech (not checked here)"); return { outputs, volumeBefore: route.outputVolume, volumeAfter: route.outputVolume }; }
  const step = 1 / 16;
  const target = options.profile?.deviceVolume;
  const min = target !== undefined ? target - step / 2 : options.quickFloor ?? 0.4;
  const max = target !== undefined ? target + step * 1.5 : 1;
  const volumeBefore = route.outputVolume;
  let volume = volumeBefore;
  if (volume < min && options.pressVolume && !driver.simulator) {
    for (let press = 0; press < 16 && volume < min; press++) {
      const r = await driver.run("pressButton", { button: "volumeUp" }, { allowFail: true });
      if (!r.ok) break;
      volume = Number(r.value);
    }
    volume = (await read()).outputVolume;
    log(`volume: ${Math.round(volumeBefore * 100)}% -> ${Math.round(volume * 100)}% (hardware volume-up)`);
  }
  const how = "play any sound on the device, set the volume while it plays, stop it, then re-run";
  if (volume < min) throw new Error(`media volume is ${Math.round(volume * 100)}%, below ${target !== undefined ? `the calibrated ${Math.round(target * 100)}%` : `the ${Math.round(min * 100)}% quick-estimate floor (no calibrated profile)`}; ${how}`);
  if (volume > max) throw new Error(`media volume is ${Math.round(volume * 100)}%, above the calibrated ${Math.round((target ?? 1) * 100)}% (+1 step); ${how}`);
  if (target === undefined) log(`volume ${Math.round(volume * 100)}% accepted against the quick-estimate floor; calibrate with --device-volume and --save-profile`);
  return { outputs, volumeBefore, volumeAfter: volume, target };
}
