import { expect, type Page } from "@playwright/test";
import { defaultEngineSettings } from "../packages/vfs/src/app-settings";
import { openAssetFromBrowser } from "./open-test-project";
import { acceptUnsavedPlayPrompts } from "./unsaved-play";

/** Homepage starter id and the project name FeatureTest routes create. */
export const FEATURE_TEST_STARTER_ID = "feature-test";
export const FEATURE_TEST_PROJECT = "FeatureTest";

/** FeatureTest scene documents that perf routes can open by name. */
export const FEATURE_TEST_SCENES = {
  main: "assets/main.scene.babasset",
  stress: "assets/FeatureTest/Scenes/FT_Stress.scene.babasset",
  clustered: "assets/FeatureTest/Scenes/FT_Clustered.scene.babasset",
  "2d": "assets/FeatureTest/Scenes/FT_2D.scene.babasset",
  world: "assets/FeatureTest/Scenes/FT_World.scene.babasset",
} as const;

export type FeatureTestSceneName = keyof typeof FEATURE_TEST_SCENES;

/** FeatureTest imports and bakes much more than the shared 30 s helpers allow. */
const LONG_MS = 180_000;

type EngineSettings = ReturnType<typeof defaultEngineSettings>;

/** Seed Engine Settings on the test origin before the editor boots. */
export async function seedEngineSettings(
  page: Page,
  patch: (settings: EngineSettings) => void = () => {},
): Promise<void> {
  const response = await page.goto("/__test_identity");
  expect(response?.ok()).toBe(true);
  const settings = defaultEngineSettings();
  patch(settings);
  await page.evaluate(
    (value) => localStorage.setItem("babylonslate:engine-settings", JSON.stringify(value)),
    settings,
  );
}

async function waitForInteractive(page: Page, timeout: number): Promise<void> {
  await acceptUnsavedPlayPrompts(page);
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible({ timeout });
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout });
}

/** Homepage → Create Project → Feature Test → editor interactive. */
export async function createFeatureTestProject(page: Page, timeout = LONG_MS): Promise<number> {
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, { timeout: 15_000 });
  await expect(page.getByTestId("homepage")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await page.getByTestId(`create-project-${FEATURE_TEST_STARTER_ID}`).click();
  await page.getByTestId("create-project-name").fill(FEATURE_TEST_PROJECT);
  const started = Date.now();
  await page.getByTestId("create-project-submit").click();
  await waitForInteractive(page, timeout);
  return Date.now() - started;
}

/** Reload and reopen FeatureTest from the Homepage list (OPFS persists in the context). */
export async function reopenFeatureTestProject(page: Page, timeout = LONG_MS): Promise<number> {
  await page.reload();
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, { timeout: 15_000 });
  const listed = page.getByTestId(`open-listed-project-${FEATURE_TEST_PROJECT}`);
  await expect(listed).toBeVisible({ timeout: 30_000 });
  const started = Date.now();
  await listed.click();
  await waitForInteractive(page, timeout);
  return Date.now() - started;
}

/** Open a FeatureTest scene and wait for its viewport to finish loading. */
export async function openFeatureTestScene(
  page: Page,
  scene: FeatureTestSceneName,
  timeout = LONG_MS,
): Promise<number> {
  const started = Date.now();
  await openAssetFromBrowser(page, FEATURE_TEST_SCENES[scene]);
  await expect(page.getByTestId("document-workspace-scene")).toBeVisible({ timeout });
  const panel = page.getByTestId("viewport-panel");
  await expect(page.getByTestId("viewport-canvas")).toBeVisible({ timeout });
  await expect(panel).toHaveAttribute("data-scene-ready", "true", { timeout });
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout });
  return Date.now() - started;
}

/** Wait until background KTX2 encodes finish so measurements see final GPU textures. */
export async function waitForTextureEncodes(page: Page, timeout = LONG_MS): Promise<number> {
  const started = Date.now();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __babylonslateTest?: { pendingTextureEncodes: () => string[] } })
              .__babylonslateTest?.pendingTextureEncodes().length ?? -1,
        ),
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(0);
  return Date.now() - started;
}
