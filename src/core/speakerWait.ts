/** Rig timing only: uses the same acoustic reply-end detector as awaitReply. */
export async function waitForSpeaker(quietMs: number, timeoutMs: number, state: () => { now: number; speaking: boolean; playing: boolean; lastEnd: number; replyStarted?: number; replyText?: string; receiptOngoing?: boolean }, pause: () => Promise<void>) {
  const started = state().now;
  for (;;) {
    const s = state();
    const fallbackQuiet = (s.replyText?.trim() && !/[.!?…]["'”’)]*$/.test(s.replyText.trim())) ||
      (s.replyStarted !== undefined && s.lastEnd - s.replyStarted > 10000) ? Math.max(quietMs, 2500) : quietMs;
    if (!s.receiptOngoing && !s.playing && !s.speaking && s.now - s.lastEnd >= fallbackQuiet) return { waitedMs: s.now - started, timedOut: false };
    if (s.now - started >= timeoutMs) return { waitedMs: s.now - started, timedOut: true };
    await pause();
  }
}
export function lineOverlaps(start: number, end: number, speech: Array<{ startMs: number; endMs: number; chime?: boolean; nonSpeech?: boolean }>) {
  return speech.some(s => !s.chime && !s.nonSpeech && s.endMs - s.startMs >= 400 && s.startMs < start && s.endMs > start && s.startMs < end);
}

export type PlaybackReceipt = {event: string; sessionId?: string; generation?: number; atWall?: number; outcome?: string};
/** Only a submission already in progress at the cue can establish overlap. */
export function receiptPlaybackOngoing(rows: PlaybackReceipt[], atWall: number) {
  return rows.some(r => {
    if (r.event !== 'reply-submitted' || !r.sessionId || r.generation === undefined || r.atWall === undefined || r.atWall > atWall) return false;
    const ends = rows.filter(end => end.sessionId === r.sessionId && end.generation === r.generation &&
      end.atWall !== undefined && end.atWall >= r.atWall!);
    if (ends.some(end => (end.event === 'reply-cancelled' || end.event === 'reply-outcome' && end.outcome === 'cancelled') && end.atWall! <= atWall)) return false;
    const complete = ends.filter(end => end.event === 'reply-completed');
    const latency = ends.filter(end => end.event === 'reply-outcome');
    // 'played' acknowledges the FIRST speech buffer,
    // so that latency receipt alone cannot establish the end of a whole reply.
    if (!complete.length && latency.every(end => end.outcome === 'played')) return true;
    const terminals = [...complete, ...latency];
    return !terminals.length || Math.max(...terminals.map(end => end.atWall!)) > atWall;
  });
}
/** App/Mac clocks can differ slightly; only a clear TTS tail proves overlap. */
export function receiptOverlap(rows: PlaybackReceipt[], atWall: number, toleranceMs = 750) {
  return receiptPlaybackOngoing(rows, atWall) && rows.some(end =>
    end.event === 'reply-completed' &&
    end.atWall !== undefined && end.atWall > atWall + toleranceMs && rows.some(start =>
      start.event === 'reply-submitted' && start.sessionId === end.sessionId && start.generation !== undefined &&
      start.generation === end.generation && start.atWall !== undefined && start.atWall <= atWall));
}
