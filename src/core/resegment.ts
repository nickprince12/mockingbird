/** Offline replay uses the same VAD and playback exclusion as the live loop. */
import { EnergyVad, defaultVad, type PlaybackWindow } from './audio.ts';
export function resegment(pcm: Buffer, playbacks: Pick<PlaybackWindow, 'startMs' | 'endMs'>[]) {
  const vad = new EnergyVad();
  for (let offset = 0; offset + 640 <= pcm.length; offset += 640) {
    let sum = 0;
    for (let i = offset; i < offset + 640; i += 2) sum += pcm.readInt16LE(i) ** 2;
    const rms = Math.sqrt(sum / 320) / 32768;
    const ms = offset / 32;
    vad.push(rms ? 20 * Math.log10(rms) : -120, ms, playbacks.some(p => ms >= p.startMs && ms <= p.endMs + defaultVad.playbackTailMs));
  }
  vad.flush(pcm.length / 32);
  return { segments: vad.segments.filter(s => !s.overlapsPlayback), noiseFloorDb: vad.noiseFloorDb };
}
