# Mockingbird design notes

## Pieces

* **Driver** (`ios/MockingbirdDriver`). One long XCUITest (`testServe`) long-polls the Mac for
  commands and drives any installed app by bundle id (`MOCKINGBIRD_BUNDLE_ID`, forwarded by
  `xcodebuild` as `TEST_RUNNER_MOCKINGBIRD_BUNDLE_ID`). Two XCUITest behaviours are handled:
  a vanished or unhittable element is a *test failure* that would end the session, so issues
  are recorded as the current command's error instead; and continuously animated screens stall
  XCUITest's "wait for idle", which is disabled in the test bundle (the same approach as
  WebDriverAgent's `waitForQuiescence=false`). Taps resolve the element once and tap its centre
  by coordinate, scrolling off-screen elements into view first. Element types: `button`,
  `control` (button, switch or toggle: web buttons with `aria-pressed` surface as switches),
  `switch`, `text`, `field`, `search`, `link`, `any`; match by exact `label`, `prefix` or
  case-insensitive `contains`.
* **Transports.** *Poll* (Simulator default): the runner long-polls the Mac's HTTP command queue. A
  Simulator reaches it on 127.0.0.1; a device needs the Mac's LAN address and **Local Network
  permission**, which iOS 26.2 denied silently on a physical iPhone, with no prompt, although the
  runner's Info.plist already carries `NSLocalNetworkUsageDescription` from Xcode's template (the
  runner runs behind the app under test). Kept for future wireless use. *USB* (physical-device default):
  the runner listens on a port on the device (`MOCKINGBIRD_SERVER_PORT`, Network.framework) and the
  Mac connects through `iproxy` (libimobiledevice, usbmux) over the cable, as WebDriverAgent does,
  so the phone must stay cabled. Each HTTP POST carries one command and its result.
* **Mic helper** (`mac/MockingbirdMic`). macOS attributes a command-line tool's microphone use
  to whichever app launched it, so an unattended runner cannot rely on its terminal's
  permission. The helper is a named app; it is launched with `open --stdout <fifo>` and streams
  16 kHz mono s16le.
* **Audio loop** (`src/core/audio.ts`). Lines rendered once with `say` (cached) and played with
  `afplay`. 20 ms frames into an energy VAD: onset at noise floor + 12 dB sustained for 160 ms
  (start back-dated), closed after 900 ms below, adaptive floor tracked on quiet frames only. A
  reply ends after 2.5 s of quiet. Frames during Mockingbird's own playback (+350 ms tail) never
  open a segment. Whole-run WAV plus per-reply slices; whisper.cpp transcribes slices when
  installed.
* **Runner** (`src/run.ts`). Loads your adapter and scenario, starts your backend (optional),
  the audio loop and the driver, walks the steps, enforces `--budget` against your backend's
  reported spend, and writes the report. Adapters can also supply live spend samples and a
  cutoff policy for independently metered runs.
* **Checks** (`src/core/assertions.ts`). Below.

## Adapter contract (`src/core/types.ts`)

`bundleId`, `requiredSteps`, `runUiStep(step, ctx)`, `readStatus(driver)`, and optionally
`prepareSimulator(udid)` (trust a test CA, `simctl privacy grant microphone`),
`startBackend(runDir, {budgetUsd, scenario})` returning a `Backend` (`spendUsd()`,
`evidence()`, `stop()`), and `evidenceFromRunDir()` for `rescore`. The step that starts a voice
session returns `voiceStartAtWall`. Backend evidence: what the app said and heard, wall times
its audio output started, and wall-timed events that count as the app advancing its task.

## Checks

| check | source | rule |
|---|---|---|
| first-words | acoustic | voice start → first heard onset under `thresholds.firstWordsMs` (default 10 s) |
| first-words:app-trace | backend | voice start → the app's own first-output event |
| every-utterance-answered | acoustic | each cue gets a reply within its timeout |
| silent-line-not-answered | acoustic | nothing heard after a line marked `expect: "silence"` |
| useful-reply-latency | acoustic | **headline**: cue end to the first reply segment that is not filler (src/core/filler.ts, on the per-segment whisper transcript); warn ≥ 6 s, fail ≥ 10 s or filler only |
| useful-reply-stalls | acoustic | fail: any useful reply ≥ 10 s, or a filler-only reply |
| filler-segments | acoustic | warn: filler-only segments ("Checking.", "One moment."), counted as their own UX cost |
| first-audio-latency | acoustic | secondary, never fails: cue end to any audio, filler included |
| no-unprompted-speech | acoustic | speech after a reply ended with no new cue (echo loop or a second answer) |
| no-repeated-line | backend | no identical sentence of 5+ words twice |
| no-self-echo-turns | backend | nothing heard matches the app's own earlier speech rather than a played line |
| app-heard-the-speaker | backend | each played line appears in what the app heard |
| advances | backend, else screen | an advancing event between this cue and the next; else the screen's progress text changed |
| status-labels | screen | required labels seen, forbidden labels never seen |

A check with no evidence is *unmeasured*; any unmeasured check makes the run `INCOMPLETE`.

## Clocks, calibration and measurement error

Two clocks meet: the mic's sample clock (frames counted) and the Mac's wall clock (playback,
UI actions). Audio arrives in buffered chunks, so the sample count at a given moment lags
real time. Mockingbird maps between them with the smallest (arrival time − sample time) seen
over the last 20 s, and times playback and UI events by wall clock mapped onto the mic clock,
never by the sample count at that moment. (An early version did the latter, and a blocking
playback call froze ingestion: onsets came out 1.4 s *before* playback.)

Each run then calibrates: a 150 ms 1 kHz tone is played three times and its onset found by
frequency (Goertzel power 20 dB over the slice median), so room noise cannot fake it. The
median offset (afplay start-up + output/input buffering + air; 170-180 ms on a MacBook Air) is
subtracted from reply latency. The run's `audio-calibration` check fails, and first-words and
useful-reply-latency and first-audio-latency become *unmeasured*, when any round misses the tone, the offset is below −30 ms
or above 1.5 s, or the rounds spread more than 150 ms.

Residual error: VAD onset ±20 ms once open (160 ms of speech needed, start back-dated); `say`
adds ~40-60 ms of leading silence to a line; voice start is a touch-down, earlier than the
app's own commit. Device-clock events from a backend are an independent second timeline
(identical clocks on a Simulator).

The VAD's noise floor is the 20th percentile of the last 3 s of non-speech frames, ignoring
digital silence (< −100 dBFS, e.g. a capture device starting), and no segment opens before
1 s of real audio.

## Limits

* No iOS microphone injection; air or a cable into the mic input (a different route).
* Device must stay unlocked; XCUITest shows an "Automation Running" overlay; Guided Access can
  block app switching, so start the runner first.
* Web views expose accessibility labels, not the DOM. Copy changes break adapters loudly (with
  a screenshot).
* The phone's echo canceller removes its own output, not Mockingbird's; reflections and external
  speakers are outside its reference. Realistic volume and distance; one route per run.
* The Simulator has no device audio processing, Bluetooth routes, interruptions or lock screen.
  Its audio paths differ by API: on Xcode 27 / iOS 26.5, `sim-audio-check` found web audio
  output and native input working but WebKit `getUserMedia` delivering digital silence. A
  web-view app's own output did not reach the Mac either in one test app's runs, cause
  unverified (its native session used `PlayAndRecord`/`VoiceChat`; Safari's output, including
  while capturing, did reach it). Run `sim-audio-check` on every new Xcode/runtime.
  macOS microphone permission comes from the app Mockingbird is launched from (or "Mockingbird
  Mic" when launched on its own) and, separately, from the Simulator.
* `say` voices are clean and evenly paced; real users and kitchens are noisier.
* Two runs on one Mac hear each other.

## Alternatives considered

* A debug-only deep link into the app's voice screen: less flaky, but skips the real controls,
  which is often where regressions are.
* WebDriverAgent / Appium's XCUITest driver: heavier (signing plus `iproxy` on hardware); Appium
  can redirect Simulator audio output to a virtual device. Not needed for this loop.
* Loopback plus the Simulator's audio-input menu instead of the air path, for the Simulator
  stage.
