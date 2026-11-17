# Mockingbird

Mockingbird tests voice apps on a physical iPhone over the air. The Mac speaks scripted lines through its speaker and captures the iPhone’s replies through its microphone. An XCUITest runner drives the app and Mockingbird records reply timing, speech detection, UI state, and pass/fail checks.

## Requirements

- A Mac with Xcode, its command-line tools, and Node.js 22 or later.
- An unlocked, trusted iPhone connected by USB, with Developer Mode enabled and the app under test installed.
- An Apple development team that can sign the XCUITest runner, and `iproxy` for USB forwarding (`brew install libimobiledevice`).
- Mac microphone permission for the terminal or IDE running Mockingbird. For local word checks, optionally install whisper.cpp and put its English base model at `~/.cache/mockingbird/ggml-base.en.bin` or set `MOCKINGBIRD_WHISPER_MODEL`.

## Quick start

Set the bundle ID, permission prompt display name, and accessibility labels in [the example adapter](examples/adapter-template.ts). Adapt [the sample scenario](examples/scenarios/sample.json) to a conversation your app supports. Place the iPhone near the Mac with both speakers audible.

```sh
npm install
npm run mic:build
npm run mockingbird -- run --adapter examples/adapter-template.ts \
  --scenario examples/scenarios/sample.json --device "<device identifier>" \
  --team "<Apple development team ID>"
```

Use `xcrun xctrace list devices` to find the iPhone. USB is the default physical-device transport. The run writes its Markdown summary, JSON report, logs, and captured audio under `reports/mockingbird/`. The optional model judge requires explicit opt-in and can incur API charges.

Status: early. The rig has been exercised on physical iPhones in one setup; expect to adjust levels and timing for yours.

## Adapters

Pass `--adapter` a TypeScript module with a default or named `adapter` export conforming to [`AppAdapter`](src/core/types.ts). The adapter supplies a bundle ID and maps scenario UI steps to driver calls. Optional hooks provide screen status, preflight and teardown, device leveling defaults, reactive synthetic-user policy, and app-side evidence for scoring. Keep app-specific code and scenarios in the app’s repository.

Use `probe` to inspect accessibility labels, `rescore` to reevaluate a saved run, and `matrix` or `compare` to compare configurations. See [DESIGN.md](DESIGN.md) for the rig architecture.

Licensed under [Apache 2.0](LICENSE).
