/** Physical devices can level the call route during app speech. */
export function levelDuringSpeech(deviceDefault: boolean, simulator: boolean, args: string[]): boolean {
  return !simulator && !args.includes('--no-level-during-speech') && (deviceDefault || args.includes('--level-during-speech'));
}

/** Explicit opt-out wins over the adapter device default and environment. */
export function quietTarget(deviceDefault: boolean, simulator: boolean, args: string[], env = process.env.MOCKINGBIRD_QUIET_TARGET): boolean {
  return !args.includes('--no-quiet-target') && (args.includes('--quiet-target') || env === '1' || (deviceDefault && !simulator));
}
