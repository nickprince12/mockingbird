/** Loads an app adapter: a module whose default (or `adapter`) export is an AppAdapter. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppAdapter } from "./core/types.ts";

export async function loadAdapter(path: string | undefined): Promise<AppAdapter> {
  if (!path) throw new Error("--adapter <path to a module exporting an AppAdapter> is required (see examples/adapter-template.ts)");
  const module = await import(pathToFileURL(resolve(path)).href);
  const adapter = (module.default ?? module.adapter) as AppAdapter | undefined;
  if (!adapter || typeof adapter.runUiStep !== "function" || typeof adapter.bundleId !== "string") throw new Error(`${path} does not export an AppAdapter`);
  return adapter;
}

export const micHelperPath = () => resolve(process.env.MOCKINGBIRD_HOME ?? `${process.env.HOME}/.cache/mockingbird`, "MockingbirdMic.app");
