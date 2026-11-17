/**
 * A minimal Mockingbird adapter. Copy it into your app's repository, replace
 * the labels with your app's accessible names (find them with
 * `mockingbird probe --bundle <your.bundle.id> --device <udid> --launch`), and
 * pass it with `--adapter path/to/your-adapter.ts`.
 *
 * Use type-only imports from Mockingbird so the adapter has no runtime
 * dependency on where Mockingbird is installed. In your own repository,
 * change the "../src/core/..." paths below to "mockingbird/core/...".
 */
import type { AppAdapter, AppStatus, UiStepContext, UiStepResult } from "../src/core/types.ts";
import type { PhoneDriver } from "../src/core/driver.ts";

const adapter: AppAdapter = {
  id: "example",
  bundleId: "com.example.voiceapp",
  // A failure here stops the run: nothing after it can be meaningful.
  requiredSteps: ["launch", "startVoice"],

  async runUiStep(step: string, { driver }: UiStepContext): Promise<UiStepResult> {
    switch (step) {
      case "launch":
        await driver.run("launch", { timeout: 25 });
        await driver.run("allowSystemAlerts", { timeout: 2, appDisplayName: "Example Voice App" }, { allowFail: true });
        return {};
      case "startVoice": {
        const tapped = await driver.run("tap", { contains: "Start talking", type: "control" });
        // First-words timing counts from here.
        return { voiceStartAtWall: Date.now() - (tapped.ms ?? 0) };
      }
      case "stopVoice":
        await driver.run("tap", { contains: "Stop", type: "control" });
        return {};
      default:
        throw new Error(`unknown step ${step}`);
    }
  },

  async readStatus(driver: PhoneDriver): Promise<AppStatus> {
    const texts = await driver.texts();
    return {
      status: texts.filter((t) => /listening|speaking|thinking|muted/i.test(t.label)).map((t) => t.label),
      labels: texts.map((t) => t.label),
      progress: texts.filter((t) => /step \d+ of \d+/i.test(t.label)).map((t) => t.label).join(" | "),
    };
  },
};

export default adapter;
