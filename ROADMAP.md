# Roadmap

Planned, not built. Each item names what passes.

## Route scenarios
Run the same scenario with the phone on an external Bluetooth speaker (A2DP).
Pass = zero self-echo turns (the app's input never matches its own output) and no repeated line.
One route per run.

## Device hygiene and calibration

Lessons from the first physical-device runs (2026-11-11). Each says where it lives.

| feature | status | where |
|---|---|---|
| Route preflight: the output must be an expected port (default built-in speaker); refuse Bluetooth/AirPods unless the scenario allows them | shipped | core (`devicePreflight`, driver `audioRoute`); adapter only chooses ports |
| Lowest reliable volume, device and host: per Mac/device/route profiles, host volume set for the run and restored after | shipped | core (`profile.ts`, `--speaker-volume`, `--device-volume`, `--save-profile`) |
| Host volume ladder: start low, raise one rung only when a line goes unanswered, replay it | shipped | core (`--speaker-volume-ladder`) |
| Press device volume only while the app under test is audibly speaking, steering to the lowest clearly detectable level; stop if presses do not move the volume | shipped, unverified on a device | core (`DeviceLevelController`, `--level-during-speech`, driver `pressButton`) |
| USB server-mode transport as the default on physical devices (no Local Network permission) | shipped | core (driver `transport: auto`) |
| Non-speech reply filtering (a thud or typing is not an answer) | shipped | core |
| Per-run calibration tone (playback-to-mic offset; latency untrusted if invalid) | shipped | core |
| "App not listening" (held, paused, muted) stops the run early | shipped | adapter hook `isListening`, checked by the core before each answered line |
| Teardown hook: always leave the app clean at the end of a run (also after an abort), e.g. end an open or held session | shipped | adapter hook `teardown`, called by the core |
| Speak after quiet by default: every line waits for the app's reply to end plus `quietBeforeMs` (2.5 s default, per scenario or line, with a timeout) and records when it was spoken | shipped | core |
| Barge-in on purpose: a line's `overlapMs` speaks into the app's speech; used by dedicated scenarios that measure the speaker-route overlap problem (a line spoken over the app's reply went unheard; heard after 5 s of quiet) | shipped | core timing + adapter scenarios marked `manualOnly` |
| Privacy preflight: Do Not Disturb on; screenshots only of the app under test | planned | core check plus adapter policy (today: screenshots are full-screen and kept local) |
| Simulator audio capability check per direction and API | shipped | core (`sim-audio-check`) |
| Reply level margin per reply, warning near the threshold (re-calibrate signal) | shipped | core |
