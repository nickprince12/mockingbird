/**
 * mockingbird <command> [options]
 *
 *   run       walk a scenario against a phone or Simulator and write a report
 *   probe     print every accessible label on screen and save a screenshot
 *   selftest  check the Mac audio loop (--live: speaker -> mic, --offline: VAD + whisper on a file)
 *   rescore   recompute checks from a saved run
 *   sim-audio-check  does a Simulator's audio reach the Mac, and the Mac's reach it?
 *   matrix    run the same scenario(s) once per arm (engine/backend) and compare them
 *   compare   side-by-side comparison of saved runs (comparison.md + .json)
 *
 * Run with tsx: `node --import tsx node_modules/mockingbird/src/cli.ts run ...`
 * or, inside this repo, `npm run mockingbird -- run ...`.
 */
const command = process.argv[2];
const usage = "usage: mockingbird <run|probe|selftest|rescore|sim-audio-check|matrix|compare> [options] (see README.md)";
switch (command) {
  case "run": { const { main } = await import("./run.ts"); await main(); break; }
  case "probe": await import("./probe.ts"); break;
  case "selftest": await import("./selftest.ts"); break;
  case "rescore": await import("./rescore.ts"); break;
  case "sim-audio-check": await import("./simcheck.ts"); break;
  case "matrix": { const { main } = await import("./matrix.ts"); await main(); break; }
  case "compare": { const { main } = await import("./compare.ts"); await main(); break; }
  default: console.error(usage); process.exitCode = 2;
}
export {};
