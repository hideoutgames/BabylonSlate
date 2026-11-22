import { expect, type Page } from "@playwright/test";
import { acceptUnsavedPlayPrompts } from "./unsaved-play";

/**
 * Click Play in a project this computer does not trust whose game holds Execute JavaScript, and check
 * that it is refused as a person sees it: the Output Log line (or, when no Output Log window shows,
 * the Play Failed dialog, closed again with Close), no Play overlay, and the trust banner naming the
 * assets. Leaves the editor ready for the next Play.
 */
export async function expectPlayRefusedUntilTrusted(page: Page, assetNames: readonly string[]): Promise<void> {
  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  const reason = `so the Execute JavaScript in ${assetNames.join(", ")} cannot run`;
  const logLine = page.getByTestId("output-log-line").filter({ hasText: reason });
  const failed = page.getByTestId("play-failed-dialog");
  await expect(logLine.or(failed).first()).toBeVisible({ timeout: 60_000 });
  if (await failed.isVisible()) {
    await expect(failed).toContainText(reason);
    await failed.getByRole("button", { name: "Close" }).click();
    await expect(failed).toBeHidden();
  } else {
    await expect(logLine.first()).toContainText("Play preparation failed: This project is not trusted on this computer");
  }
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await expect(page.getByTestId("project-trust-banner")).toContainText(`Execute JavaScript (${assetNames.join(", ")})`);
}

/** Trust the open project through its banner, as a person would, and wait for the banner to go. */
export async function trustProject(page: Page): Promise<void> {
  const banner = page.getByTestId("project-trust-banner");
  await banner.getByTestId("project-trust-accept").click();
  await expect(banner).toBeHidden();
}
