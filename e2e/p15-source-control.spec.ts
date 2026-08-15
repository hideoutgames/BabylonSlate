import { expect, test, type Page } from "@playwright/test";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

const SCENE_PATH = "assets/main.scene.babasset";
const CLASS_PATH = "assets/main.class.babasset";

async function closeSettings(page: Page): Promise<void> {
  await page
    .getByTestId("settings-modal")
    .locator('[data-slot="dialog-close"]')
    .click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
}

async function enableSourceControl(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-modal-category-sourceControl").click();
  const enable = page.getByTestId("settings-source-control-enabled");
  await expect(enable).toHaveAttribute("aria-checked", "false");
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await closeSettings(page);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const host = globalThis as {
          __babylonslateSourceControl?: { enabled: boolean };
        };
        return host.__babylonslateSourceControl?.enabled === true;
      }),
    )
    .toBe(true);
}

async function openWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

function visibleLocksPanel(page: Page) {
  return page.getByTestId("locks-panel").filter({ visible: true });
}

async function ensureLocksPanel(page: Page): Promise<void> {
  if ((await visibleLocksPanel(page).count()) > 0) {
    await expect(visibleLocksPanel(page)).toBeVisible();
    return;
  }
  await expect(page.getByTestId("windows-menu")).toBeEnabled();
  await openWindowsMenu(page);
  await page.getByTestId("windows-menu-locks").click({ force: true });
  await expect(visibleLocksPanel(page)).toBeVisible();
}

test.describe("P15 source-control locking", () => {
  test("enables Fake locks, auto-locks on edit, Edit Anyway, Release All, and mtime reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    await enableSourceControl(page);

    await openMainScene(page);
    await ensureLocksPanel(page);
    await expect(
      visibleLocksPanel(page).getByTestId("locks-release-all"),
    ).toHaveText("Release All My Locks (0)");

    const nudged = await page.evaluate(async () => {
      const host = globalThis as {
        __babylonslateTest?: {
          nudgeActiveSceneActor: () => Promise<boolean>;
          cancelDebouncedSave: () => void;
        };
      };
      const ok = (await host.__babylonslateTest?.nudgeActiveSceneActor()) ?? false;
      host.__babylonslateTest?.cancelDebouncedSave();
      return ok;
    });
    expect(nudged).toBe(true);

    await expect(
      visibleLocksPanel(page).getByTestId("locks-release-all"),
    ).toHaveText("Release All My Locks (1)");
    await expect(
      visibleLocksPanel(page).getByTestId(`locks-row-${SCENE_PATH}`),
    ).toHaveAttribute("data-lock-ours", "true");

    await openContentBrowser(page);
    await expect(
      page.locator(`[data-asset-path="${SCENE_PATH}"] [data-lock-slot]`),
    ).toHaveAttribute("data-lock-state", "mine");

    await page.evaluate(async () => {
      const host = globalThis as {
        __babylonslateSourceControl?: {
          fakeProvider: {
            addTheirs: (path: string, ownerName: string) => unknown;
          } | null;
          refresh: () => Promise<void>;
        };
      };
      const sc = host.__babylonslateSourceControl;
      sc?.fakeProvider?.addTheirs("assets/main.class.babasset", "Teammate");
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
    await page.getByTestId("document-lock-edit-anyway").click();
    await expect(page.getByTestId("document-lock-edit-anyway")).toBeVisible();

    await ensureLocksPanel(page);
    await visibleLocksPanel(page).getByTestId("locks-release-all").click();
    await expect(page.getByTestId("locks-release-all-confirm")).toContainText(
      "Unpushed work becomes editable by others.",
    );
    await page.getByTestId("locks-release-all-cancel").click();
    await expect(page.getByTestId("locks-release-all-confirm")).toHaveCount(0);

    await page.evaluate(async (path) => {
      const host = globalThis as {
        __babylonslateTest?: {
          touchAssetOnDisk: (path: string) => Promise<void>;
          runForegroundRescan: () => Promise<void>;
          cancelDebouncedSave: () => void;
        };
      };
      host.__babylonslateTest?.cancelDebouncedSave();
      await host.__babylonslateTest?.touchAssetOnDisk(path);
      await host.__babylonslateTest?.runForegroundRescan();
    }, SCENE_PATH);

    await expect(page.getByTestId("external-change-dirty-disk")).toBeVisible();
    await expect(page.getByTestId("external-change-dirty-disk")).toContainText(
      SCENE_PATH,
    );
    await page.getByTestId("external-change-keep-edits").click();
    await expect(page.getByTestId("external-change-dirty-disk")).toHaveCount(0);
  });
});
