import path from "node:path";
import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

async function showContentBrowser(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: import("@playwright/test").Page,
  type: "UserInterface" | "Sprite" | "AnimationGraph" | "Shader",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId("new-asset-type").click();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

test.describe("P9 content systems", () => {
  test("UserInterface designer switches iPad and desktop presets", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    const canvas = page.getByTestId("ui-design-canvas");
    await expect(canvas).toHaveAttribute("data-preset", "ipad-landscape");
    await expect(page.getByTestId("ui-widget-stick")).toBeVisible();
    await expect(page.getByTestId("ui-widget-header")).toBeVisible();
    const landscapeStickX = await page
      .getByTestId("ui-widget-stick")
      .getAttribute("data-gui-x");
    const landscapeHeaderY = await page
      .getByTestId("ui-widget-header")
      .getAttribute("data-gui-y");

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-ipad-portrait").click();
    await expect(canvas).toHaveAttribute("data-preset", "ipad-portrait");
    const portraitStickX = await page
      .getByTestId("ui-widget-stick")
      .getAttribute("data-gui-x");
    const portraitHeaderY = await page
      .getByTestId("ui-widget-header")
      .getAttribute("data-gui-y");
    expect(portraitStickX).not.toBe(landscapeStickX);
    expect(portraitHeaderY).not.toBe(landscapeHeaderY);

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-desktop-16-9").click();
    await expect(canvas).toHaveAttribute("data-preset", "desktop-16-9");

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-desired").click();
    await expect(canvas).toHaveAttribute("data-preset", "desired");
    await expect(page.getByTestId("ui-desired-width")).toBeVisible();
    await expect(page.getByTestId("ui-desired-height")).toBeVisible();
  });

  test("UserInterface designer drags a widget and undo restores it", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("ui-design-viewport")).toBeVisible();
    const stick = page.getByTestId("ui-widget-stick");
    const before = await stick.getAttribute("data-gui-x");
    const box = await stick.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2);
    await page.mouse.up();
    await expect
      .poll(async () => stick.getAttribute("data-gui-x"))
      .not.toBe(before);
    await page.getByTestId("undo-document").click();
    await expect.poll(async () => stick.getAttribute("data-gui-x")).toBe(before);

    await page.getByTestId("ui-design-viewport").hover();
    await page.mouse.wheel(0, -180);
    await expect(page.getByTestId("ui-design-canvas")).not.toHaveAttribute(
      "data-zoom",
      "1",
    );
    await page.getByTestId("ui-widget-header").click();
    await expect(page.getByTestId("property-name")).toHaveValue("Title");
    await expect(page.getByTestId("property-offset-min-x")).toBeVisible();
  });

  test("UserInterface designer lists a custom Engine Settings preset", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    const canvas = page.getByTestId("ui-design-canvas");

    await page.getByTestId("settings-menu").click();
    await page.getByTestId("engine-settings").click();
    await page.getByTestId("engine-settings-modal-category-ui").click();
    await page.getByTestId("ui-preset-add").click();
    const customRow = page.locator('[data-testid^="ui-preset-custom-"]');
    await expect(customRow).toBeVisible();
    const rowTestId = await customRow.getAttribute("data-testid");
    const presetId = rowTestId?.replace("ui-preset-custom-", "") ?? "";
    expect(presetId).toMatch(/^custom-/);
    await page.getByTestId(`ui-preset-label-${presetId}`).fill("Phone");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("engine-settings-modal")).toHaveCount(0);

    await page.getByTestId("ui-device-preset").click();
    await expect(page.getByTestId(`ui-preset-${presetId}`)).toBeVisible();
    await page.getByTestId(`ui-preset-${presetId}`).click();
    await expect(canvas).toHaveAttribute("data-preset", presetId);
  });

  test("UserInterface designer on iPad shows the same HUD widgets", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-widget-stick")).toBeVisible();
  });

  test("Font editor sample preview uses the compiled stack", async ({ page }) => {
    await openTestProject(page);
    await showContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([path.join(process.cwd(), "e2e/fixtures/display.woff2")]);
    await expect(
      page.locator('[data-asset-path="assets/display.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-asset-path="assets/display.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-font")).toBeVisible();
    const sample = page.getByTestId("font-sample-preview");
    await expect(sample).toBeVisible();
    await expect(sample).toHaveAttribute("data-fonts-ready", "true");
    await expect(sample).toContainText("The quick brown fox");
    const family = await sample.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family.toLowerCase()).toMatch(/display|sans-serif/);
    const stack = await sample.getAttribute("data-font-stack");
    expect(stack?.toLowerCase()).toContain("sans-serif");
    expect(stack?.toLowerCase()).toMatch(/display/);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-fonts").click();
    await expect(page.getByTestId("settings-global-fallback")).toContainText(
      "sans-serif",
    );
    await page.getByTestId("settings-modal-category-input").click();
    await expect(page.getByTestId("settings-input-mapping")).toBeVisible();
    await expect(page.getByTestId("settings-input-actions")).toHaveCount(0);
  });

  test("Play overlay stick drives the same Move.x as the gamepad path", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-hud")).toBeVisible();
    await expect(page.getByTestId("play-hud-stick")).toHaveCount(0);

    await page.evaluate(() => {
      (
        globalThis as {
          __babylonslateTest: {
            injectTestTouchAxis: (axes: Record<string, number> | null) => void;
          };
        }
      ).__babylonslateTest.injectTestTouchAxis({
        "joystick-x": 0.85,
        "joystick-y": 0,
      });
    });
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-move-x")
          .getAttribute("data-move-x");
        return Number(attr ?? "0");
      })
      .toBeGreaterThan(0.5);

    await page.evaluate(() => {
      (
        globalThis as {
          __babylonslateTest: {
            injectTestTouchAxis: (axes: Record<string, number> | null) => void;
            injectTestGamepad: (
              pad: { axes: number[]; buttons?: number[] } | null,
            ) => void;
          };
        }
      ).__babylonslateTest.injectTestTouchAxis(null);
    });
    await page.getByTestId("play-overlay-close").click();

    await page.evaluate(() => {
      (
        globalThis as {
          __babylonslateTest: {
            injectTestGamepad: (
              pad: { axes: number[]; buttons?: number[] } | null,
            ) => void;
          };
        }
      ).__babylonslateTest.injectTestGamepad({
        axes: [0.85, 0, 0, 0],
        buttons: [0, 0, 0, 0],
      });
    });
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-move-x")
          .getAttribute("data-move-x");
        return Number(attr ?? "0");
      })
      .toBeGreaterThan(0.5);
    await page.getByTestId("play-overlay-close").click();
  });

  test("Sprite, AnimationGraph, and Shader open document workspaces", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "Sprite", "Hero");
    await page.locator('[data-asset-path="assets/Hero.sprite.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-sprite")).toBeVisible();
    await expect(page.getByTestId("sprite-editor")).toBeVisible();
    await expect(page.getByTestId("property-texture")).toBeVisible();

    await createAsset(page, "AnimationGraph", "Loco");
    await page.locator('[data-asset-path="assets/Loco.anim.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-anim-graph")).toBeVisible();
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
    await expect(page.getByTestId("anim-graph-parameters")).toBeVisible();
    await expect(page.getByTestId("anim-graph-add-state")).toBeVisible();

    await createAsset(page, "Shader", "Surface");
    await page.locator('[data-asset-path="assets/Surface.shader.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-shader")).toBeVisible();
    await expect(page.getByTestId("shader-graph-editor")).toBeVisible();
    await expect(page.getByTestId("shader-preview")).toBeVisible();
  });

  test("Play overlay stick is reachable on iPad", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }, testInfo) => {
    await openTestProject(page);
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-hud")).toBeVisible();
    await expect(page.getByTestId("play-hud-stick")).toHaveCount(0);
    // Desktop-chrome also runs @ipad tests (see docs/architecture/testing.md).
    // Only the iPad projects use 1194×834 / 834×1194, which map to iPad
    // presets and non-zero safe-area insets.
    const preset = await page.getByTestId("play-hud").getAttribute("data-preset");
    const safeTop = Number(
      await page.getByTestId("play-hud").getAttribute("data-safe-top"),
    );
    if (testInfo.project.name === "ipad-landscape") {
      expect(preset).toBe("ipad-landscape");
      expect(safeTop).toBeGreaterThan(0);
    } else if (testInfo.project.name === "ipad-portrait") {
      expect(preset).toBe("ipad-portrait");
      expect(safeTop).toBeGreaterThan(0);
    } else {
      expect(preset).toBe("desktop-16-9");
      expect(safeTop).toBe(0);
    }
    await page.getByTestId("play-overlay-close").click();
  });

  test("Play applies a UserInterface only when a class graph asks", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    const guid = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __babylonslateTest?: { guidForPath: (path: string) => string | null };
      };
      return host.__babylonslateTest?.guidForPath("assets/HUD.ui.babasset") ?? "";
    });
    expect(guid).not.toBe("");
    const installed = await page.evaluate(
      async ({ graph }) => {
        const host = globalThis as unknown as {
          __babylonslateTest?: {
            setMainGraphContent: (g: unknown) => Promise<boolean>;
          };
        };
        return host.__babylonslateTest?.setMainGraphContent(graph) ?? false;
      },
      {
        graph: {
          nodes: [
            {
              id: "begin",
              type: "flow.event.beginPlay",
              position: { x: 40, y: 80 },
              data: {},
            },
            {
              id: "apply",
              type: "ui.applyToViewport",
              position: { x: 320, y: 80 },
              data: { asset: guid },
            },
          ],
          edges: [
            {
              id: "e1",
              source: "begin",
              target: "apply",
              sourceHandle: "execOut",
              targetHandle: "execIn",
            },
          ],
        },
      },
    );
    expect(installed).toBe(true);

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-hud-stick")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("play-overlay-close").click();
  });

  test("UserInterface designer cannot nest itself", async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await createAsset(page, "UserInterface", "Panel");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await page.getByTestId("ui-add-widget-UserInterface").click();
    await page.getByTestId("property-nestedUi").click();
    await expect(page.getByTestId("ui-nested-picker")).toBeVisible();
    await expect(
      page.getByTestId("ui-nested-picker").getByText("Panel", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("ui-nested-picker").getByText("HUD", { exact: true }),
    ).toHaveCount(0);
  });
});
