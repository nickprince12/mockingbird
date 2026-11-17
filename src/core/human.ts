/** Optional adapter policy for reactive scenario steps. */
import type { CheckResult } from './assertions.ts';
export type Intent = { name: string; item?: string; alt?: string; duration?: string };
export type HumanStep = { intent?: Intent; until?: string; maxTurns?: number; maxRetries?: number; stepGroup?: number };
export type Observation = { text?: string; source: string; instruction?: string; phase?: string; question?: boolean; progress?: string };
export type HumanTurn = { before: Observation; after: Observation; intent: string; stepGroup?: number; completed?: boolean; names?: string[] };
export type ActionContext = { history?: Observation[]; names?: string[]; continues?: number };
export interface SyntheticUser {
  random(): number;
  observe(text: string | undefined, source: string): Observation;
  speak(step: HumanStep, before: Observation, retry: boolean, previous?: string): string;
  names(scenario: Record<string, unknown>): string[];
  decide(step: HumanStep, before: Observation, after: Observation, attempt: number, repeated: number, context: ActionContext): 'done' | 'retry' | 'continue' | 'fail';
  completesStep(step: HumanStep, decision: string): boolean;
  checks(turns: HumanTurn[], scenario: Record<string, unknown>, trace: unknown): CheckResult[];
  coverage: Record<string, { selected: number; variants: string[] }>;
  bankSizes: Record<string, number>;
}
export function seededRandom(seed: string) {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
export function renderPauses(text: string, enabled: boolean) { return text.replaceAll('[[pause]]', enabled ? '[[slnc 650]]' : ' '); }
export function humanMarkdown(h: any) { return h ? `## Synthetic user coverage\n\nSeed: ${h.seed}; voice: ${h.voice}; rate: ${h.rate}. Early speech is experimental onset-relative overlap, not a predicted endpoint.\n\n| intent | selections | unique variants | bank size |\n|---|---|---|---|\n${Object.entries(h.coverage as SyntheticUser['coverage']).map(([k,v])=>`| ${k} | ${v.selected} | ${v.variants.length} | ${h.bankSizes[k]} |`).join('\n')}\n` : ''; }
