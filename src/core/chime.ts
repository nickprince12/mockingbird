/** Detect repeating short alarm pulses so they are excluded from speech checks. */
export interface Segment { startMs: number; endMs: number }
export interface ChimeTrain { startMs: number; endMs: number; periodMs: number; pulses: number }

export interface ChimeOptions {
  /** Longest segment that counts as a pulse. */
  maxPulseMs?: number;
  /** Period search range. */
  minPeriodMs?: number;
  maxPeriodMs?: number;
  /** How far a pulse may sit off the period grid. */
  toleranceMs?: number;
  /** Fewest pulses that make a train. */
  minPulses?: number;
  /** Longest run of missed pulses (merged into a reply, or masked) a train survives. */
  maxSkippedPeriods?: number;
}

const defaults: Required<ChimeOptions> = { maxPulseMs: 500, minPeriodMs: 1000, maxPeriodMs: 4000, toleranceMs: 120, minPulses: 4, maxSkippedPeriods: 15 };

/** Pulse trains among these segments, and a membership test for single segments. */
export function detectChimeTrains(segments: Segment[], options: ChimeOptions = {}): { trains: ChimeTrain[]; isChime: (s: Segment) => boolean } {
  const o = { ...defaults, ...options };
  const pulses = segments.filter((s) => s.endMs - s.startMs <= o.maxPulseMs).sort((a, b) => a.startMs - b.startMs);
  const none = { trains: [] as ChimeTrain[], isChime: () => false };
  if (pulses.length < o.minPulses) return none;
  // The period: the most common gap between consecutive pulses, in 20 ms bins.
  const bins = new Map<number, number>();
  for (let i = 1; i < pulses.length; i++) {
    const gap = pulses[i].startMs - pulses[i - 1].startMs;
    if (gap < o.minPeriodMs || gap > o.maxPeriodMs) continue;
    const bin = Math.round(gap / 20) * 20;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const best = [...bins.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!best || best[1] < o.minPulses - 1) return none;
  // Refine the period from the gaps in and next to the winning bin.
  const near = [];
  for (let i = 1; i < pulses.length; i++) { const gap = pulses[i].startMs - pulses[i - 1].startMs; if (Math.abs(gap - best[0]) <= 30) near.push(gap); }
  const period = near.reduce((a, b) => a + b, 0) / near.length;
  // Chain pulses whose spacing is a whole number of periods.
  const onGrid = (gap: number) => { const k = Math.round(gap / period); return k >= 1 && k <= o.maxSkippedPeriods + 1 && Math.abs(gap - k * period) <= o.toleranceMs; };
  const chains: Segment[][] = [];
  let chain: Segment[] = [pulses[0]];
  for (let i = 1; i < pulses.length; i++) {
    const gap = pulses[i].startMs - chain[chain.length - 1].startMs;
    if (onGrid(gap)) chain.push(pulses[i]);
    // An off-grid short segment inside the train (a one-word reply) is not a
    // pulse and does not break the train; a long silence does.
    else if (chain.length >= o.minPulses && gap <= (o.maxSkippedPeriods + 1) * period + o.toleranceMs) continue;
    else { chains.push(chain); chain = [pulses[i]]; }
  }
  chains.push(chain);
  const kept = chains.filter((c) => c.length >= o.minPulses);
  if (!kept.length) return none;
  // By timing, not identity: callers copy segments.
  const key = (s: Segment) => `${s.startMs}:${s.endMs}`;
  const members = new Set<string>(kept.flat().map(key));
  const trains = kept.map((c) => ({ startMs: c[0].startMs, endMs: c[c.length - 1].endMs, periodMs: Math.round(period), pulses: c.length }));
  return { trains, isChime: (s) => members.has(key(s)) };
}
