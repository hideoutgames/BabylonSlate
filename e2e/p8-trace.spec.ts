import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

async function playTickIndex(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const host = globalThis as unknown as {
      __babylonslatePlayTest?: { tickIndex?: () => number };
    };
    return host.__babylonslatePlayTest?.tickIndex?.() ?? 0;
  });
}

async function runPlayConsole(page: import("@playwright/test").Page, line: string) {
  await page.getByTestId("play-console-open").click();
  await expect(page.getByTestId("debug-console")).toBeVisible();
  await page.getByTestId("debug-console-input").fill(line);
  await page.getByTestId("debug-console-submit").click();
  await expect(page.getByTestId("debug-console-transcript")).toContainText(line, {
    timeout: 10_000,
  });
  await page.getByTestId("debug-console").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("debug-console")).toBeHidden();
}

test.describe("P8 Trace document tab", () => {
  test("Play snapshot recording opens a Trace DockView tab on Stop", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-trace-playback")).toHaveCount(0);

    await page.getByTestId("play-stats-toggle").click();
    await expect
      .poll(
        async () => {
          const attr = await page.getByTestId("play-fps").getAttribute("data-fps");
          return Number(attr ?? "0");
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    await runPlayConsole(page, "snapshot start");
    // `data-fps` is a 1 Hz integer and can stay 60 on a stable CI vsync.
    // The recorder needs extra sim ticks, not an FPS string change.
    const startedTick = await playTickIndex(page);
    await expect
      .poll(async () => (await playTickIndex(page)) >= startedTick + 2, {
        timeout: 10_000,
      })
      .toBe(true);
    await expect(page.getByTestId("play-trace-playback")).toHaveCount(0);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);

    await expect(page.getByTestId("document-workspace-trace")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="trace"]'),
    ).toBeVisible();
    await expect(page.getByTestId("trace-timeline-panel")).toBeVisible();
    await expect(page.getByTestId("trace-snapshot-panel")).toBeVisible();
    await expect(page.getByTestId("trace-log-panel")).toBeVisible();
    await expect(page.getByTestId("trace-playback-graph-bar-0")).toBeVisible();
    await expect(page.getByTestId("trace-playback-graph-bar-1")).toBeVisible();
    await expect(page.getByTestId("trace-playback-scrubber")).toBeVisible();

    const before = await page.getByTestId("trace-playback-snapshot").textContent();
    await page.getByTestId("trace-playback-graph-bar-0").click();
    await expect(page.getByTestId("trace-playback-frame")).toHaveValue("0");
    await expect(page.getByTestId("trace-playback-snapshot")).not.toHaveText(
      before ?? "",
    );

    await page.getByTestId("windows-menu").click();
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-timeline")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-snapshot")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-log")).toBeVisible();
  });
});
