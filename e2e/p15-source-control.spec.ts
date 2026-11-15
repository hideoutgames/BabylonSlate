import { expect, test, type Page } from "@playwright/test";
import {
  closeSettings,
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

const SCENE_PATH = "assets/main.scene.hasset";
const CLASS_PATH = "assets/Mannequin.class.hasset";

/** Manual mode on a GitHub repository, then device sign-in through test mode's fake GitHub from the banner. */
async function turnOnManualAndSignIn(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-modal-category-sourceControl").click();
  await expect(page.getByTestId("settings-source-control-mode-off")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-source-control-url").fill("https://github.com/team/game.git");
  await page.getByTestId("settings-source-control-mode-manual").click();
  await expect(page.getByTestId("settings-source-control-mode-manual")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-source-control-account-state")).toHaveText("Not Signed In");
  await closeSettings(page);

  // No credential yet: one prompt, and no lock requests.
  const banner = page.getByTestId("source-control-sign-in-banner");
  await expect(banner).toContainText("This project uses GitHub file locking.");
  await banner.getByRole("button", { name: "Sign In" }).click();
  const warning = page.getByTestId("source-control-link-warning");
  await expect(warning).toContainText("Link GitHub?");
  await expect(warning).toContainText("You use this integration at your own risk.");
  await warning.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("source-control-sign-in-dialog")).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const host = globalThis as {
          __hapticSourceControl?: { enabled: boolean };
        };
        return host.__hapticSourceControl?.enabled === true;
      }),
    )
    .toBe(true);
}

function visibleLocksPanel(page: Page) {
  return page.getByTestId("locks-panel").filter({ visible: true });
}

/** Locks lives only in the pinned Source Control tab, at the right end of the tabs. */
async function openSourceControlTab(page: Page): Promise<void> {
  const tab = page.getByTestId("document-tab-pinned-end").getByTestId("document-tab");
  await expect(tab).toHaveAttribute("data-document-kind", "source-control");
  await tab.getByRole("button", { name: "Source Control" }).click();
  await expect(visibleLocksPanel(page)).toBeVisible();
}

function classReadOnly(page: Page): Promise<boolean | null> {
  return page.evaluate((path) => {
    const host = globalThis as {
      __hapticSourceControl?: { isDocumentReadOnly: (path: string) => boolean };
    };
    return host.__hapticSourceControl?.isDocumentReadOnly(path) ?? null;
  }, CLASS_PATH);
}

function dirtyKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = globalThis as {
      __hapticTest?: { dirtyDocuments: () => { kind: string }[] };
    };
    return host.__hapticTest?.dirtyDocuments().map((doc) => doc.kind) ?? [];
  });
}

test.describe("P15 source-control locking", () => {
  test("shows no Source Control tab or prompt while the mode is Off", async ({ page }) => {
    await openTestProject(page);
    await expect(page.getByTestId("document-tab-bar")).toBeVisible();
    await expect(page.getByTestId("document-tab-pinned-end")).toHaveCount(0);
    await expect(page.getByTestId("source-control-sign-in-banner")).toHaveCount(0);
    await expect(page.locator('[data-document-kind="source-control"]')).toHaveCount(0);
  });

  test("signs in from the prompt, auto-locks on edit in the Source Control tab, Edit Anyway, Release All, and mtime reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    await turnOnManualAndSignIn(page);

    await openSourceControlTab(page);
    await expect(
      visibleLocksPanel(page).getByTestId("locks-release-all"),
    ).toHaveText("Release All My Locks (0)");
    await openContentBrowser(page);
    await openMainScene(page);

    const nudged = await page.evaluate(async () => {
      const host = globalThis as {
        __hapticTest?: {
          nudgeActiveSceneActor: () => Promise<boolean>;
          cancelDebouncedSave: () => void;
        };
      };
      const ok = (await host.__hapticTest?.nudgeActiveSceneActor()) ?? false;
      host.__hapticTest?.cancelDebouncedSave();
      return ok;
    });
    expect(nudged).toBe(true);

    await openSourceControlTab(page);
    await expect(
      visibleLocksPanel(page).getByTestId("locks-release-all"),
    ).toHaveText("Release All My Locks (1)");
    await expect(
      visibleLocksPanel(page).getByTestId(`locks-row-${SCENE_PATH}`),
    ).toHaveAttribute("data-lock-ours", "true");
    // The fake GitHub branch holds nothing yet, so our lock is not pushed.
    await expect(visibleLocksPanel(page).getByTestId(`locks-pushed-${SCENE_PATH}`)).toHaveText("Not Pushed");
    await expect(visibleLocksPanel(page).getByTestId("locks-release-pushed")).toHaveText("Release Pushed Locks (0)");

    await openContentBrowser(page);
    await expect(
      page.locator(`[data-asset-path="${SCENE_PATH}"] [data-lock-slot]`),
    ).toHaveAttribute("data-lock-state", "mine");

    await page.evaluate(async () => {
      const host = globalThis as {
        __hapticSourceControl?: {
          fakeProvider: {
            addTheirs: (path: string, ownerName: string) => unknown;
          } | null;
          refresh: () => Promise<void>;
        };
      };
      const sc = host.__hapticSourceControl;
      sc?.fakeProvider?.addTheirs("assets/Mannequin.class.hasset", "Teammate");
      await sc?.refresh();
    });

    await openAssetFromBrowser(page, CLASS_PATH);
    await expect(page.getByTestId("document-lock-banner")).toHaveAttribute(
      "data-lock-banner",
      "theirs",
    );
    await expect(page.getByTestId("document-lock-banner")).toContainText(
      "Locked by Teammate",
    );
    // Edit Anyway keeps the owner banner but lifts the read-only guard.
    await expect.poll(() => classReadOnly(page)).toBe(true);
    await page.getByTestId("document-lock-edit-anyway").click();
    await expect.poll(() => classReadOnly(page)).toBe(false);
    await expect(page.getByTestId("document-lock-banner")).toContainText(
      "Locked by Teammate",
    );

    await openSourceControlTab(page);
    await visibleLocksPanel(page).getByTestId("locks-release-all").click();
    await expect(page.getByTestId("locks-release-all-confirm")).toContainText(
      "Unpushed work becomes editable by others.",
    );
    await page.getByTestId("locks-release-all-confirm-action").click();
    await expect(page.getByTestId("locks-release-all-confirm")).toHaveCount(0);
    await expect(
      visibleLocksPanel(page).getByTestId("locks-release-all"),
    ).toHaveText("Release All My Locks (0)");
    await expect(
      visibleLocksPanel(page).getByTestId(`locks-row-${SCENE_PATH}`),
    ).toHaveCount(0);

    await page.evaluate(async (path) => {
      const host = globalThis as {
        __hapticTest?: {
          touchAssetOnDisk: (path: string) => Promise<void>;
          runForegroundRescan: () => Promise<void>;
          cancelDebouncedSave: () => void;
        };
      };
      host.__hapticTest?.cancelDebouncedSave();
      await host.__hapticTest?.touchAssetOnDisk(path);
      await host.__hapticTest?.runForegroundRescan();
    }, SCENE_PATH);

    await expect(page.getByTestId("external-change-dirty-disk")).toBeVisible();
    await expect(page.getByTestId("external-change-dirty-disk")).toContainText(
      SCENE_PATH,
    );
    expect(await dirtyKinds(page)).toContain("scene");
    await page.getByTestId("external-change-reload-from-disk").click();
    await expect(page.getByTestId("external-change-dirty-disk")).toHaveCount(0);
    // Reloading discards the unsaved nudge in favor of the file on disk.
    await expect.poll(() => dirtyKinds(page)).not.toContain("scene");
  });
});
