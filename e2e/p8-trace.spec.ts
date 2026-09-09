import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

async function playTickIndex(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const host = globalThis as unknown as {
      __babylonslatePlayTest?: { tickIndex?: () => number };
    };
    return host.__babylonslatePlayTest?.tickIndex?.() ?? 0;
  });
}

async function runPlayConsole(
  page: import("@playwright/test").Page,
  line: string,
) {
  await page.getByTestId("play-console-open").click();
  await expect(page.getByTestId("debug-console")).toBeVisible();
  await page.getByTestId("debug-console-input").fill(line);
  await page.getByTestId("debug-console-submit").click();
  await expect(page.getByTestId("debug-console-transcript")).toContainText(
    line,
    {
      timeout: 10_000,
    },
  );
  await page
    .getByTestId("debug-console")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByTestId("debug-console")).toBeHidden();
}

test.describe("P8 Trace document tab", () => {
  test("Play snapshot recording opens a Trace DockView tab on Stop", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-trace-playback")).toHaveCount(0);

    await page.getByTestId("play-stats-toggle").click();
    await expect
      .poll(
        async () => {
          const attr = await page
            .getByTestId("play-fps")
            .getAttribute("data-fps");
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
    const timingBars = page
      .getByTestId("trace-playback-graph")
      .getByRole("button");
    await expect(timingBars.nth(0)).toBeVisible();
    await expect(timingBars.nth(1)).toBeVisible();
    await expect(page.getByTestId("trace-playback-scrubber")).toBeVisible();

    const tree = page.getByRole("tree", { name: "Snapshot", exact: true });
    await expect(tree).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search Snapshot" })
      .fill("position");
    const xRow = tree.getByRole("treeitem", { name: /^X / }).first();
    await expect(xRow).toBeVisible();
    await xRow.click({ position: { x: 12, y: 12 } });
    await expect(page.getByTestId("trace-value-detail")).toContainText(
      "/transform/position/0",
    );
    await expect(
      page.getByRole("button", { name: "Copy Value", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("trace-value-detail")).toBeInViewport();

    const before = await page
      .getByTestId("trace-playback-snapshot")
      .textContent();
    // Long recordings group graph bars by peak tick; select an exact frame
    // through the frame input so this check does not depend on bucket size.
    const frameInput = page.getByTestId("trace-playback-frame");
    await frameInput.fill("0");
    await frameInput.blur();
    await expect(frameInput).toHaveValue("0");
    await expect(page.getByTestId("trace-playback-snapshot")).not.toHaveText(
      before ?? "",
    );
    const tick = await page
      .getByTestId("trace-playback-snapshot")
      .getAttribute("data-tick");
    await expect(page.getByTestId("trace-frame-summary")).toContainText(
      `Tick ${tick}`,
    );
    await frameInput.fill("0.5");
    await frameInput.blur();
    await expect(frameInput).toHaveValue("0");
    for (const dark of [false, true]) {
      await page.evaluate(
        (enabled) => document.documentElement.classList.toggle("dark", enabled),
        dark,
      );
      const color = await page
        .getByTestId("trace-selection-indicator")
        .evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        });
      expect(color[0]!).toBeGreaterThan(color[1]! + 30);
      expect(color[1]!).toBeGreaterThan(color[2]! + 30);
      await page.screenshot({
        path: testInfo.outputPath(dark ? "trace-dark.png" : "trace-light.png"),
      });
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(tree).toBeVisible();
    expect(
      await page
        .getByTestId("trace-playback-graph")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    await page.getByTestId("windows-menu").click();
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-timeline")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-snapshot")).toBeVisible();
    await expect(page.getByTestId("windows-menu-trace-log")).toBeVisible();
    await page.getByTestId("windows-menu-trace-snapshot").click();
    await expect(page.getByTestId("trace-snapshot-panel")).toHaveCount(0);
    await page.getByTestId("windows-menu-trace-snapshot").click();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("textbox", { name: "Search Snapshot" }),
    ).toHaveValue("position");
    await expect(page.getByTestId("trace-value-detail")).toContainText(
      "/transform/position/0",
    );
  });
});
