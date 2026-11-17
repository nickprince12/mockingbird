/**
 * Filler: speech that fills a wait without moving the user forward
 * ("Checking.", "One moment.", "Mm-hm."). An assistant that says it fast
 * scores well on time-to-first-audio while the user still waits, so voice
 * apps are benchmarked on time to the first USEFUL speech: the first reply
 * segment whose transcript is not entirely filler. Filler segments are also
 * counted, since filler is itself a UX cost.
 *
 * The single list. It runs on a local whisper transcript of a short segment,
 * so it is deliberately loose: whisper renders "Mm-hm" as "MMA" or "Mhm" and
 * "Got it" as "God it", and those spellings are listed too. Matching is on
 * whole normalized words: a segment is filler only if every word is consumed
 * by these phrases, so "Okay, preheat the oven" is useful speech.
 */
export const fillerPhrases: readonly string[] = [
  "checking", "let me check", "let me check on that", "let me see", "let me look", "let me take a look",
  "one moment", "one sec", "one second", "just a moment", "just a sec", "just a second", "hold on", "give me a second",
  "okay", "ok", "mm hm", "mm hmm", "mhm", "mm", "mmm", "hmm", "hm", "uh huh", "mma", "m hm",
  "got it", "god it", "sure", "alright", "all right",
];

const normWords = (text: string) => text.toLowerCase()
  .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ") // whisper's markers: [BLANK_AUDIO], (sighs)
  .replace(/[^a-z0-9' ]+/g, " ").replace(/'/g, "").split(/\s+/).filter(Boolean);

const phrases = fillerPhrases.map((p) => normWords(p)).sort((a, b) => b.length - a.length);

/** Words at the start of `text` consumed by filler phrases (longest phrase first). */
export function leadingFillerWords(text: string): number {
  const words = normWords(text);
  let i = 0;
  outer: while (i < words.length) {
    for (const phrase of phrases) {
      if (phrase.every((w, k) => words[i + k] === w)) { i += phrase.length; continue outer; }
    }
    break;
  }
  return i;
}

/** True when the transcript has words and every one of them is filler. */
export function isFillerOnly(text: string): boolean {
  const n = normWords(text).length;
  return n > 0 && leadingFillerWords(text) === n;
}
