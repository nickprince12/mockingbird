/** Compare only timestamped renderer evidence belonging to the run's sessions. */
export function captureDiagnosis(report: any) {
  const receipts = (report.appEvidence?.sessions ?? []).flatMap((s: any) => s.events ?? []);
  // Score attribution matters: an ambient segment that began before a cue can
  // contain rendered speech yet be rejected by awaitReply's since boundary.
  const speech = (report.turns ?? []).flatMap((t: any) => t.segments?.length ? t.segments.filter((s: any) => !s.nonSpeech && !s.overlapsPlayback) : Number.isFinite(t.replyStartMs) ? [{ startMs: t.replyStartMs, endMs: t.replyEndMs ?? t.replyStartMs + 200 }] : []);
  const anchor = report.turns?.find((t: any) => Number.isFinite(t.cueEndWall));
  if (!anchor) return [];
  const offset = anchor.cueEndWall - anchor.cueEndMs;
  const lastTurn = report.turns?.at(-1);
  const end = offset + (lastTurn?.replyEndMs ?? (lastTurn?.cueEndMs ?? 0) + 20000);
  const times = receipts.filter((r: any) => r.event === 'playback-observed' && Number.isFinite(r.atWall) && r.atWall >= anchor.cueEndWall - 3000 && r.atWall <= end + 3000).map((r: any) => r.atWall as number).sort((a: number, b: number) => a - b);
  const windows: { start: number; end: number }[] = [];
  for (const at of times) {
    const last = windows.at(-1);
    if (last && at - last.end <= 1000) last.end = at;
    else windows.push({ start: at, end: at });
  }
  // App archive time and Mac capture time are different clocks. Use a
  // conservative 3 s uncertainty on both matching and playback exemption.
  const excluded = windows.filter(r => (report.timeline?.playbacks ?? []).some((p: any) => offset + p.startMs <= r.end + 3000 && offset + p.endMs + 350 >= r.start - 3000));
  const missed = windows.filter(r => !excluded.includes(r) && !speech.some((s: any) => offset + s.startMs <= r.end + 3000 && offset + s.endMs >= r.start - 3000));
  const exempt = excluded.length ? [{ id: 'renderer-playback-overlap', source: 'rig/infra', verdict: 'unmeasured' as const, detail: `${excluded.length} renderer windows overlap rig playback + 350 ms tail (3 s clock uncertainty); cannot measure capture` }] : [];
  return missed.length ? [{ id: 'played-not-heard', source: 'rig/infra', verdict: 'fail' as const,
    detail: `played-not-heard: ${missed.length} playback-observed windows outside attributed mic replies; capture/detection gap, not proof of product silence` }, ...exempt] : exempt;
}
