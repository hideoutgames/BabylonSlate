import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";
import {
  EXPECTED_PREVIEW_ACTOR_POSITIONS,
  previewPlacementScene,
} from "./preview-scene-fixture";
import { createMeshComponent } from "../packages/core/src/index.ts";

async function showContentBrowser(
  page: Page,
): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: Page,
  type:
    | "UserInterface"
    | "Sprite"
    | "SpriteAnimation"
    | "AnimationGraph"
    | "Material"
    | "MaterialFunction",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  const assetsRoot = page.getByTestId("tree-row-assets");
  if ((await assetsRoot.count()) > 0) {
    await assetsRoot.click();
  }
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function openWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function closeWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (!(await content.isVisible())) return;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (await content.isVisible()) {
    await page.mouse.click(12, 12);
  }
  await expect(content).toHaveCount(0);
}

function animStateMachine(page: Page) {
  return page.getByTestId("anim-dock-surface-state-machine");
}

function animObject(page: Page) {
  return page.getByTestId("anim-dock-surface-animation-object");
}

async function guidForPath(page: Page, assetPath: string): Promise<string> {
  return page.evaluate((path) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(path) ?? "";
  }, assetPath);
}

async function dispatchPreviewWheel(
  canvas: ReturnType<Page["getByTestId"]>,
  deltaY: number,
): Promise<void> {
  await canvas.evaluate((node, dy) => {
    node.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: dy,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, deltaY);
}

async function dispatchPreviewPinch(
  canvas: ReturnType<Page["getByTestId"]>,
  fromSpread: number,
  toSpread: number,
): Promise<void> {
  await canvas.evaluate(
    (node, spreads) => {
      const box = node.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const fire = (
        type: string,
        pointerId: number,
        x: number,
        y: number,
      ) => {
        node.dispatchEvent(
          new PointerEvent(type, {
            pointerId,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire("pointerdown", 1, cx - spreads.from, cy);
      fire("pointerdown", 2, cx + spreads.from, cy);
      fire("pointermove", 1, cx - spreads.to, cy);
      fire("pointermove", 2, cx + spreads.to, cy);
      fire("pointerup", 1, cx - spreads.to, cy);
      fire("pointerup", 2, cx + spreads.to, cy);
    },
    { from: fromSpread, to: toSpread },
  );
}

async function addMaterialPaletteNode(
  page: Page,
  search: string,
  itemId: string,
): Promise<void> {
  const graph = page.getByTestId("material-graph-editor");
  await expect(graph).toBeVisible();
  // Toolbar Add node: default Color / Output shells can cover pane-center
  // double-tap after the wider Blueprint min-width.
  await graph.getByTestId("graph-add-node").click();
  await expect(page.getByTestId("node-palette")).toBeVisible();
  await page.getByTestId("node-palette-search").fill(search);
  await page.getByTestId(`node-palette-item-${itemId}`).click();
  await expect(page.getByTestId("node-palette")).toHaveCount(0);
  await graph.locator(`.react-flow__node[data-id^="${itemId}-"]`).click();
}

async function importAlbedoTexture(page: Page): Promise<string> {
  await showContentBrowser(page);
  await page
    .getByTestId("content-browser-import-input")
    .setInputFiles([path.join(process.cwd(), "e2e/fixtures/albedo.png")]);
  await expect(
    page.locator('[data-asset-path="assets/albedo.babasset"]'),
  ).toBeVisible({ timeout: 15_000 });
  const albedoGuid = await guidForPath(page, "assets/albedo.babasset");
  expect(albedoGuid.length).toBeGreaterThan(0);
  return albedoGuid;
}

async function pickMaterialNodeTexture(page: Page, guid: string): Promise<void> {
  await expect(page.getByTestId("material-details-panel")).toBeVisible();
  await page.getByTestId("material-node-texture").click();
  await expect(page.getByTestId("material-node-texture-picker")).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId("material-node-texture-picker")).toHaveCount(0);
  await expect(page.getByTestId("material-node-texture")).toContainText(
    /albedo/i,
  );
}

async function connectMaterialPins(
  page: Page,
  sourcePrefix: string,
  sourcePin: string,
  targetSelector: string,
  targetPin: string,
): Promise<void> {
  const graph = page.getByTestId("material-graph-editor");
  const source = graph.locator(
    `.react-flow__node[data-id^="${sourcePrefix}"] [data-handleid="${sourcePin}"][data-handlepos="right"]`,
  );
  const target = graph.locator(
    `.react-flow__node${targetSelector} [data-handleid="${targetPin}"][data-handlepos="left"]`,
  );
  await source.click({ force: true });
  await target.click({ force: true });
}

async function dragMaterialNode(
  page: Page,
  nodePrefix: string,
  dx: number,
  dy: number,
): Promise<void> {
  const node = page
    .getByTestId("material-graph-editor")
    .locator(`.react-flow__node[data-id^="${nodePrefix}"]`);
  const title = node.locator("[data-node-role] > div").first();
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2);
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function compileMaterialPreview(page: Page): Promise<void> {
  const canvas = page.getByTestId("material-preview-canvas");
  const render = page.getByTestId("material-render");
  // Force a compile of the wired graph. Auto-compile may already be in
  // flight (Render disabled); wait it out, then click.
  await expect(render).toBeEnabled({ timeout: 15_000 });
  await render.click();
  await expect(canvas).toHaveAttribute("data-status", "ready", {
    timeout: 15_000,
  });
}

test.describe("P9 content systems", () => {
  test("UserInterface designer switches 4:3, 16:9, and widescreen presets", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    const canvas = page.getByTestId("ui-design-canvas");
    await expect(canvas).toHaveAttribute("data-preset", "desktop-16-9");
    await expect(page.getByTestId("ui-widget-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-widget-stick")).toHaveCount(0);
    await expect(page.getByTestId("ui-widget-header")).toHaveCount(0);
    const sixteenNineBox = await canvas.boundingBox();
    expect(sixteenNineBox).not.toBeNull();

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-desktop-4-3").click();
    await expect(canvas).toHaveAttribute("data-preset", "desktop-4-3");
    const fourThreeBox = await canvas.boundingBox();
    expect(fourThreeBox).not.toBeNull();
    expect(fourThreeBox!.width / fourThreeBox!.height).toBeCloseTo(4 / 3, 1);
    expect(sixteenNineBox!.width / sixteenNineBox!.height).toBeCloseTo(16 / 9, 1);

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-desktop-21-9").click();
    await expect(canvas).toHaveAttribute("data-preset", "desktop-21-9");

    await page.getByTestId("ui-device-preset").click();
    await page.getByTestId("ui-preset-desired").click();
    await expect(canvas).toHaveAttribute("data-preset", "desired");
    await expect(page.getByTestId("ui-desired-width")).toHaveCount(0);
    await expect(page.getByTestId("ui-desired-height")).toHaveCount(0);
    const desiredBox = await canvas.boundingBox();
    expect(desiredBox).not.toBeNull();
    expect(desiredBox!.width).toBeLessThan(500);
    expect(desiredBox!.height).toBeLessThan(500);
  });

  test("UserInterface designer drags a widget and undo restores it", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("ui-design-viewport")).toBeVisible();
    await page.getByTestId("ui-add-widget").click();
    await page.getByTestId("ui-add-widget-Button").click();
    await expect(page.getByTestId("ui-widget-catalog")).toHaveCount(0);
    const button = page.locator('[data-testid^="ui-widget-button-"]');
    await expect(button).toBeVisible();
    // Add Widget selects the control. 44px screen-space handles then cover a
    // 36px-tall Button on a fitted 1920 canvas, so a center press would resize.
    await page.getByTestId("ui-widget-canvas").click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId("ui-resize-se")).toHaveCount(0);
    const before = await button.getAttribute("data-gui-x");
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(async () => button.getAttribute("data-gui-x"))
      .not.toBe(before);
    await page.getByTestId("undo-document").click();
    await expect.poll(async () => button.getAttribute("data-gui-x")).toBe(before);

    await page.getByTestId("ui-design-viewport").hover();
    await page.mouse.wheel(0, -180);
    await expect(page.getByTestId("ui-design-canvas")).not.toHaveAttribute(
      "data-zoom",
      "1",
    );
    await page.locator('[data-testid^="tree-row-button-"]').click();
    await expect(page.getByTestId("property-name")).toHaveValue("Button");
    await expect(page.getByTestId("property-left")).toBeVisible();
    await expect(page.getByTestId("property-top")).toBeVisible();
    await expect(page.getByTestId("property-width")).toBeVisible();
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

  test("UserInterface designer on iPad opens a Canvas-only document", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-widget-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-widget-stick")).toHaveCount(0);
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
    await expect(page.getByTestId("input-action-0-binding-0-code")).toBeVisible();
    await expect(page.getByText(/press a key/i)).toHaveCount(0);
  });

  test("Play overlay stick drives the same Move.x as the gamepad path", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
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
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
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

  test("Sprite, AnimationGraph, and Material open document workspaces", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "Sprite", "Hero");
    await page.locator('[data-asset-path="assets/Hero.sprite.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-sprite")).toBeVisible();
    await expect(page.getByTestId("sprite-preview")).toBeVisible();
    await expect(page.getByTestId("sprite-editor")).toBeVisible();
    await expect(page.getByTestId("property-texture")).toBeVisible();

    await createAsset(page, "SpriteAnimation", "Walk");
    await page
      .locator('[data-asset-path="assets/Walk.spriteanim.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-sprite-animation")).toBeVisible();
    await expect(page.getByTestId("sprite-animation-preview")).toBeVisible();
    await expect(page.getByTestId("sprite-animation-play")).toBeVisible();
    await expect(page.getByTestId("sprite-animation-editor")).toBeVisible();

    await createAsset(page, "AnimationGraph", "Loco");
    await page.locator('[data-asset-path="assets/Loco.anim.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-anim-graph")).toBeVisible();
    await expect(page.getByTestId("anim-editor-mode-bar")).toBeVisible();
    await expect(page.getByTestId("anim-editor-mode-state-machine")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("anim-dock-surface-state-machine")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
    await expect(animStateMachine(page).getByTestId("anim-graph-parameters")).toBeVisible();
    await expect(page.getByTestId("anim-graph-add-state")).toBeVisible();

    await createAsset(page, "Material", "Surface");
    await page
      .locator('[data-asset-path="assets/Surface.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("material-graph-editor")).toBeVisible();
    await expect(page.getByTestId("material-preview-canvas")).toBeVisible();
  });

  test("Animation Graph switches State Machine and Animation Object catalogs", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    await createAsset(page, "AnimationGraph", "Loco");
    await page.locator('[data-asset-path="assets/Loco.anim.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-anim-graph")).toBeVisible();
    await expect(page.getByTestId("anim-editor-mode-bar")).toBeVisible();
    await expect(page.getByTestId("anim-dock-surface-state-machine")).toHaveAttribute(
      "data-active",
      "true",
    );
    const stateMachine = animStateMachine(page);
    await expect(stateMachine.getByTestId("anim-graph-add-variable")).toBeVisible();
    await expect(stateMachine.getByTestId("anim-graph-add-variable")).not.toHaveClass(
      /min-h-\[var\(--touch-target/,
    );
    await stateMachine.getByTestId("anim-graph-add-variable").click();
    await expect(stateMachine.getByTestId("anim-graph-variable-var-1")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-anim-graph-graph")).toBeVisible();
    await expect(page.getByTestId("windows-menu-anim-graph-variables")).toBeVisible();
    await expect(page.getByTestId("windows-menu-anim-graph-details")).toBeVisible();
    await expect(page.getByTestId("windows-menu-anim-object-graph")).toHaveCount(0);
    await closeWindowsMenu(page);

    await page.getByTestId("anim-graph-add-state").click();
    await expect(page.getByTestId("anim-state-node-idle")).toBeVisible();
    await expect(page.getByTestId("anim-state-node-state-1")).toBeVisible();
    const idleFlow = page.locator('.react-flow__node[data-id="idle"]');
    const idleBefore = await idleFlow.evaluate((el) => (el as HTMLElement).style.transform);
    const idleTitle = page.getByTestId("anim-state-node-idle").locator(".anim-state-node-title");
    const titleBox = await idleTitle.boundingBox();
    expect(titleBox).not.toBeNull();
    const titleX = titleBox!.x + titleBox!.width / 2;
    const titleY = titleBox!.y + titleBox!.height / 2;
    await page.mouse.move(titleX, titleY);
    await page.mouse.down();
    await page.mouse.move(titleX, titleY + 80, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => idleFlow.evaluate((el) => (el as HTMLElement).style.transform))
      .not.toBe(idleBefore);
    await expect(page.locator('[data-testid^="anim-transition-badge-"]')).toHaveCount(0);
    const idleOut = page
      .getByTestId("anim-state-node-idle")
      .locator('[data-handleid="right-out"]');
    const nextIn = page
      .getByTestId("anim-state-node-state-1")
      .locator('[data-handleid="left-in"]');
    await idleOut.dragTo(nextIn);
    const badge = page.locator('[data-testid^="anim-transition-badge-"]');
    await expect(badge).toBeVisible();
    await badge.dblclick();
    await expect(page.getByTestId("anim-rule-graph")).toBeVisible();
    await expect(page.getByTestId("anim-rule-breadcrumb")).toContainText("Idle To State");
    await page.getByTestId("anim-rule-breadcrumb-state-machine").click();
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();

    await page.getByTestId("anim-graph-state-idle").click();
    await expect(page.getByTestId("property-clipKind")).toBeVisible();
    await page.getByTestId("property-clipAsset").click();
    await expect(page.getByTestId("anim-graph-clip-picker")).toBeVisible();
    await expect(page.getByTestId("anim-graph-clip-picker").getByText("Pick Animation")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("property-clipKind").click();
    await page.getByRole("option", { name: "Sprite" }).click();
    await page.getByTestId("property-clipAsset").click();
    await expect(page.getByTestId("anim-graph-clip-picker")).toBeVisible();
    await expect(
      page.getByTestId("anim-graph-clip-picker").getByText("Pick Sprite Animation"),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("anim-editor-mode-animation-object").click();
    await expect(page.getByTestId("anim-editor-mode-animation-object")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("anim-dock-surface-animation-object")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("anim-dock-surface-state-machine")).toHaveAttribute(
      "data-active",
      "false",
    );
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(animObject(page).getByTestId("anim-graph-variable-var-1")).toBeVisible();

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-anim-object-graph")).toBeVisible();
    await expect(page.getByTestId("windows-menu-anim-object-inspector")).toBeVisible();
    await expect(page.getByTestId("windows-menu-anim-graph-details")).toHaveCount(0);
    await closeWindowsMenu(page);
  });

  test("Material preview compiles the authored graph and follows the primitive picker", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "Material", "Rock");
    await page
      .locator('[data-asset-path="assets/Rock.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();

    // A cheap surface graph compiles on its own and reports a ready preview.
    const canvas = page.getByTestId("material-preview-canvas");
    await expect(canvas).toHaveAttribute("data-status", "ready", {
      timeout: 15000,
    });
    const renderButton = page.getByTestId("material-render");
    await expect(renderButton).toBeVisible();
    await expect(renderButton).toBeEnabled();
    await expect(
      page.getByTestId("editor-global-toolbar").getByTestId("material-render"),
    ).toHaveCount(1);
    await expect(
      page.getByTestId("material-preview-overlay").getByTestId("material-render"),
    ).toHaveCount(0);
    await expect(page.getByTestId("material-preview-status")).toHaveCount(0);
    await expect(page.getByTestId("material-preview-custom-mesh")).toHaveCount(0);
    await expect(page.getByTestId("material-compiler-results")).toContainText(
      "No Issues",
    );

    await renderButton.click();
    await expect(renderButton).toBeDisabled();
    await page.waitForTimeout(2_000);
    await expect(renderButton).toBeDisabled();
    await expect(renderButton).toBeEnabled({ timeout: 5_000 });

    // Every primitive is reachable from the overlay mesh ToggleGroup.
    for (const mesh of ["cube", "cylinder", "cone", "plane"]) {
      await page.getByTestId(`material-preview-mesh-${mesh}`).click();
      await expect(canvas).toHaveAttribute("data-status", "ready", {
        timeout: 15000,
      });
    }
    await page.getByTestId("material-preview-mesh-custom").click();
    await expect(page.getByTestId("material-preview-mesh-picker")).toBeVisible();
    await page.getByTestId("search-item-__none__").click();
    await expect(page.getByTestId("material-preview-mesh-picker")).toHaveCount(0);

    // A static preview must replace its RTT each frame rather than accumulating
    // prior frames into progressively brighter trails.
    await page.waitForTimeout(500);
    const stableFrameA = await canvas.screenshot();
    await page.waitForTimeout(500);
    const stableFrameB = await canvas.screenshot();
    expect(stableFrameB.equals(stableFrameA)).toBe(true);

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await expect(canvas).toHaveAttribute("data-camera-radius");
    const radiusBefore = Number(await canvas.getAttribute("data-camera-radius"));
    expect(radiusBefore).toBeGreaterThan(0);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 48,
      box!.y + box!.height / 2 + 24,
    );
    await page.mouse.up();
    await expect
      .poll(async () => {
        const value = await canvas.getAttribute("data-camera-radius");
        return value && Number.isFinite(Number(value)) ? Number(value) : null;
      })
      .not.toBeNull();
    const radiusBeforeWheel = Number(
      await canvas.getAttribute("data-camera-radius"),
    );
    await dispatchPreviewWheel(canvas, 400);
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-camera-radius")))
      .not.toBeCloseTo(radiusBeforeWheel, 3);
    const radiusBeforePinch = Number(
      await canvas.getAttribute("data-camera-radius"),
    );
    await dispatchPreviewPinch(canvas, 36, 72);
    await expect(canvas).toHaveAttribute("data-status", "ready", {
      timeout: 15000,
    });
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-camera-radius")))
      .not.toBeCloseTo(radiusBeforePinch, 3);
  });

  test("Scene viewport and Play overlay keep working after a Material tab mounts", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();

    await createAsset(page, "Material", "Studio");
    await page
      .locator('[data-asset-path="assets/Studio.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("material-preview-canvas")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 15_000 },
    );

    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("outliner-add-actor")).toBeVisible();

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-stats-toggle").click();
    await expect(page.getByTestId("stats-hud-draws")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("stats-hud-draws")
          .getAttribute("data-draws");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
  });

  test("Material Windows menu lists the material docks", async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "Material", "Docked");
    await page
      .locator('[data-asset-path="assets/Docked.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await page.getByTestId("windows-menu").click();
    await expect(
      page.getByTestId("windows-menu-material-preview"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-material-compiler-results"),
    ).toBeVisible();
  });

  test("Custom GLSL node compiles an expression in the Material editor", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "Material", "Glsl");
    await page
      .locator('[data-asset-path="assets/Glsl.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("material-details-panel")).toBeVisible();
    await addMaterialPaletteNode(page, "Custom GLSL", "custom.glsl");
    const glsl = page.getByTestId("material-node-glsl");
    await expect(glsl).toBeVisible();
    await expect(page.getByTestId("material-node-glsl-signature")).toContainText(
      "result = fn(a, b)",
    );
    await glsl.fill("#define X 1");
    await expect(
      page.getByTestId("material-diagnostic-material.customGlsl"),
    ).toBeVisible({ timeout: 10_000 });
    await glsl.fill("a + b");
    await expect(
      page.getByTestId("material-diagnostic-material.customGlsl"),
    ).toHaveCount(0);
    const graph = page.getByTestId("material-graph-editor");
    const source = graph.locator(
      '.react-flow__node[data-id^="custom.glsl-"] [data-handleid="out"][data-handlepos="right"]',
    );
    const target = graph.locator(
      '.react-flow__node[data-id="output"] [data-handleid="metallic"][data-handlepos="left"]',
    );
    await source.click({ force: true });
    await target.click({ force: true });
    await expect(page.getByTestId("material-render")).toBeEnabled();
    await page.getByTestId("material-render").click();
    await expect(page.getByTestId("material-preview-canvas")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 15_000 },
    );
  });

  test("Texture Sample node can pick an inline Texture asset", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    const albedoGuid = await importAlbedoTexture(page);
    await createAsset(page, "Material", "Sampled");
    await openAssetFromBrowser(page, "assets/Sampled.material.babasset");
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await addMaterialPaletteNode(page, "Texture Sample", "texture.sample");
    await pickMaterialNodeTexture(page, albedoGuid);
    const graph = page.getByTestId("material-graph-editor");
    await connectMaterialPins(
      page,
      "texture.sample-",
      "rgb",
      '[data-id="output"]',
      "baseColor",
    );
    await expect(
      graph.locator('.react-flow__edge[data-id*=":rgb:output:baseColor"]'),
    ).toHaveCount(1);
    await compileMaterialPreview(page);
  });

  test("Texture Parameter wires into Texture Sample for a ready preview", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTestProject(page);
    const albedoGuid = await importAlbedoTexture(page);
    await createAsset(page, "Material", "ParamSample");
    await openAssetFromBrowser(page, "assets/ParamSample.material.babasset");
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await addMaterialPaletteNode(page, "Texture Parameter", "param.texture");
    await pickMaterialNodeTexture(page, albedoGuid);
    await dragMaterialNode(page, "param.texture-", -220, -40);
    await addMaterialPaletteNode(page, "Texture Sample", "texture.sample");
    const graph = page.getByTestId("material-graph-editor");
    await connectMaterialPins(
      page,
      "param.texture-",
      "out",
      '[data-id^="texture.sample-"]',
      "texture",
    );
    await expect(
      graph.locator(
        '.react-flow__edge[data-id^="e:param.texture-"][data-id*=":texture"]',
      ),
    ).toHaveCount(1);
    await connectMaterialPins(
      page,
      "texture.sample-",
      "rgb",
      '[data-id="output"]',
      "baseColor",
    );
    await expect(
      graph.locator('.react-flow__edge[data-id*=":rgb:output:baseColor"]'),
    ).toHaveCount(1);
    await compileMaterialPreview(page);
  });

  test("scene post-process stack applies in Play and respects Engine Settings", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await createAsset(page, "Material", "Bloom");
    await page
      .locator('[data-asset-path="assets/Bloom.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("property-domain")).toBeVisible();
    await page.getByTestId("property-domain").click();
    await page.getByRole("option", { name: "Post Process" }).click();
    await expect(page.getByTestId("property-domain")).toContainText(
      "Post Process",
    );
    await saveAllIfEnabled(page);
    await openMainScene(page);
    await expect(page.getByTestId("scene-post-process-stack")).toBeVisible();
    await page.getByTestId("scene-post-process-stack-add").click();
    await expect(page.getByTestId("scene-post-process-picker")).toBeVisible();
    const bloomGuid = await guidForPath(
      page,
      "assets/Bloom.material.babasset",
    );
    expect(bloomGuid.length).toBeGreaterThan(0);
    await page.getByTestId(`search-item-${bloomGuid}`).click();
    await expect(page.getByTestId("scene-post-process-0-material")).toContainText(
      "Bloom",
    );
    await clickPlayAndWaitForOverlay(page);
    const overlay = page.getByTestId("play-overlay");
    await expect
      .poll(async () => overlay.getAttribute("data-post-process-passes"), {
        timeout: 15_000,
      })
      .toBe("1");
    await page.getByTestId("play-overlay-close").click();
    await expect(overlay).toHaveCount(0);
    if ((await page.getByTestId("preview-session-report").count()) > 0) {
      await page.getByTestId("session-report-close").click();
    }
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("engine-settings").click();
    await page.getByTestId("engine-settings-modal-category-viewport").click();
    await expect(page.getByTestId("setting-post-processing")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("setting-post-processing").click();
    await expect(page.getByTestId("setting-post-processing")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page
      .getByTestId("engine-settings-modal")
      .locator('[data-slot="dialog-close"]')
      .click();
    await expect(page.getByTestId("engine-settings-modal")).toHaveCount(0);
    await clickPlayAndWaitForOverlay(page);
    await expect
      .poll(async () => overlay.getAttribute("data-post-process-passes"), {
        timeout: 15_000,
      })
      .toBe("0");
    await page.getByTestId("play-overlay-close").click();
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("scene-post-process-0-material")).toContainText(
      "Bloom",
    );
  });

  test("Play assigns a MeshComponent surface material", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await createAsset(page, "Material", "Rock");
    await saveAllIfEnabled(page);
    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-shape-box").click();
    const materialButton = page.locator('button[data-testid$="-materialGuid"]');
    await expect(materialButton).toBeVisible();
    await materialButton.click();
    await expect(page.getByTestId("details-asset-picker")).toBeVisible();
    const rockGuid = await guidForPath(page, "assets/Rock.material.babasset");
    expect(rockGuid.length).toBeGreaterThan(0);
    await page.getByTestId(`search-item-${rockGuid}`).click();
    await expect(page.getByTestId("details-asset-picker")).toHaveCount(0);
    await clickPlayAndWaitForOverlay(page);
    const overlay = page.getByTestId("play-overlay");
    await expect
      .poll(async () => overlay.getAttribute("data-assigned-materials"), {
        timeout: 15_000,
      })
      .toBe(rockGuid);
    await page.getByTestId("play-overlay-close").click();
  });

  test("Scene and Prefab previews render authored MeshComponent materials", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await createAsset(page, "Material", "PreviewRock");
    await saveAllIfEnabled(page);
    const materialGuid = await guidForPath(
      page,
      "assets/PreviewRock.material.babasset",
    );
    expect(materialGuid.length).toBeGreaterThan(0);

    await openMainScene(page);
    const scene = previewPlacementScene(materialGuid);
    expect(
      await page.evaluate(async (nextScene) => {
        const host = globalThis as unknown as {
          __babylonslateTest?: {
            setActiveSceneContent: (scene: typeof nextScene) => Promise<boolean>;
          };
        };
        return host.__babylonslateTest?.setActiveSceneContent(nextScene) ?? false;
      }, scene),
    ).toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = globalThis as unknown as {
              __babylonslateViewportTest?: {
                sceneVisuals: () => Array<{
                  actorId: string;
                  materialName: string | null;
                }>;
              };
            };
            return host.__babylonslateViewportTest
              ?.sceneVisuals()
              .find((visual) => visual.actorId === "material-actor")
              ?.materialName ?? null;
          }),
        { timeout: 15_000 },
      )
      .toContain(materialGuid);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = globalThis as unknown as {
            __babylonslateViewportTest?: {
              sceneVisuals: () => Array<{
                actorId: string;
                position: [number, number, number];
              }>;
            };
          };
          return Object.fromEntries(
            (host.__babylonslateViewportTest?.sceneVisuals() ?? []).map(
              (visual) => [visual.actorId, visual.position],
            ),
          );
        }),
      )
      .toMatchObject({
        "material-actor": [-3, 1, 0],
        "child-actor": [-1, 1, 0],
        "far-actor": [4, -1, 0],
      });

    await clickPlayAndWaitForOverlay(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = globalThis as unknown as {
              __babylonslatePlayTest?: {
                actorPositions: () => Array<{
                  x: number;
                  y: number;
                  z: number;
                }>;
              };
            };
            return (host.__babylonslatePlayTest?.actorPositions() ?? [])
              .map(({ x, y, z }) => [x, y, z])
              .sort((a, b) => a[0]! - b[0]!);
          }),
        { timeout: 15_000 },
      )
      .toEqual(expect.arrayContaining(EXPECTED_PREVIEW_ACTOR_POSITIONS));
    await page.getByTestId("play-overlay-close").click();

    await showContentBrowser(page);
    await page.locator('[data-asset-path="assets/main.class.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    const prefabMesh = createMeshComponent("prefab-material", "box");
    prefabMesh.properties.materialGuid = materialGuid;
    expect(
      await page.evaluate(async (components) => {
        const host = globalThis as unknown as {
          __babylonslateTest?: {
            setMainGraphComponents: (
              value: typeof components,
            ) => Promise<boolean>;
          };
        };
        return (
          (await host.__babylonslateTest?.setMainGraphComponents(components)) ??
          false
        );
      }, [prefabMesh]),
    ).toBe(true);
    await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
    await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = globalThis as unknown as {
              __babylonslatePrefabViewportTest?: {
                visuals: () => Array<{
                  actorId: string;
                  materialName: string | null;
                }>;
              };
            };
            return host.__babylonslatePrefabViewportTest
              ?.visuals()
              .find((visual) => visual.actorId === "prefab-material")
              ?.materialName ?? null;
          }),
        { timeout: 15_000 },
      )
      .toContain(materialGuid);
    const rootMaterial = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __babylonslatePrefabViewportTest?: {
          visuals: () => Array<{
            actorId: string;
            materialName: string | null;
          }>;
        };
      };
      return host.__babylonslatePrefabViewportTest
        ?.visuals()
        .find((visual) => visual.actorId === "prefab-root")?.materialName ?? "";
    });
    expect(rootMaterial).not.toContain(materialGuid);
  });

  test("Material Function edits reach every calling material", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "MaterialFunction", "Tint");
    await page
      .locator('[data-asset-path="assets/Tint.matfunc.babasset"]')
      .dblclick();
    await expect(
      page.getByTestId("document-workspace-material-function"),
    ).toBeVisible();
    await expect(page.getByTestId("material-function-graph-editor")).toBeVisible();
    await expect(page.getByTestId("material-function-inputs")).toBeVisible();
    await expect(page.getByTestId("material-function-outputs")).toBeVisible();
  });

  test("Play overlay stick is reachable on iPad", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }, testInfo) => {
    await openTestProject(page);
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-hud")).toBeVisible();
    await expect(page.getByTestId("play-hud-stick")).toHaveCount(0);
    // Desktop-chrome also runs @ipad tests (see docs/architecture/testing.md).
    // iPad Playwright viewport is landscape 1194×834 and maps to 4:3
    // (closest aspect) with zero safe-area insets.
    const preset = await page.getByTestId("play-hud").getAttribute("data-preset");
    const safeTop = Number(
      await page.getByTestId("play-hud").getAttribute("data-safe-top"),
    );
    if (testInfo.project.name === "ipad-landscape") {
      expect(preset).toBe("desktop-4-3");
      expect(safeTop).toBe(0);
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
              data: { "default:asset": `UserInterface:${guid}` },
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

    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(
      page.locator('[data-testid="play-hud"] [data-kind="Canvas"]'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("play-hud-stick")).toHaveCount(0);
    await page.getByTestId("play-overlay-close").click();
  });

  test("Play applies a UI class, routes button events, and keeps instances independent", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    const guid = await guidForPath(page, "assets/HUD.ui.babasset");
    expect(guid).not.toBe("");
    const classId = `UserInterface:${guid}`;
    const installedUi = await page.evaluate(
      async ({ path, content }) => {
        const host = globalThis as unknown as {
          __babylonslateTest?: {
            setUiDocumentContent: (
              path: string,
              content: Record<string, unknown>,
            ) => Promise<boolean>;
          };
        };
        return host.__babylonslateTest?.setUiDocumentContent(path, content) ?? false;
      },
      {
        path: "assets/HUD.ui.babasset",
        content: {
          name: "HUD",
          rootId: "canvas",
          widgets: {
            canvas: {
              id: "canvas",
              kind: "Canvas",
              name: "Canvas",
              children: ["play-btn", "logo"],
              visible: true,
              style: {},
              props: {},
            },
            "play-btn": {
              id: "play-btn",
              kind: "Button",
              name: "Play",
              children: [],
              visible: true,
              style: {},
              props: { text: "Play" },
            },
            logo: {
              id: "logo",
              kind: "Image",
              name: "Logo",
              children: [],
              visible: true,
              style: {},
              props: {},
            },
          },
          logic: {
            nodes: [
              {
                id: "click",
                type: "flow.event.custom",
                position: { x: 40, y: 80 },
                data: { name: "onWidgetClick" },
              },
              {
                id: "log",
                type: "debug.log",
                position: { x: 320, y: 80 },
                data: { "default:message": "hud-clicked" },
              },
              {
                id: "self",
                type: "actor.getSelf",
                position: { x: 320, y: 200 },
                data: {},
              },
              {
                id: "cast",
                type: "casting.cast",
                position: { x: 440, y: 200 },
                data: {
                  "default:class": "UserInterface",
                  defaultClassId: "UserInterface",
                  resultKind: "objectRef",
                },
              },
              {
                id: "remove",
                type: "ui.removeFromViewport",
                position: { x: 560, y: 80 },
                data: {},
              },
            ],
            edges: [
              {
                id: "e1",
                source: "click",
                target: "log",
                sourceHandle: "execOut",
                targetHandle: "execIn",
              },
              {
                id: "e2",
                source: "log",
                target: "remove",
                sourceHandle: "execOut",
                targetHandle: "execIn",
              },
              {
                id: "e3",
                source: "self",
                target: "cast",
                sourceHandle: "out",
                targetHandle: "object",
              },
              {
                id: "e4",
                source: "cast",
                target: "remove",
                sourceHandle: "result",
                targetHandle: "instance",
              },
            ],
          },
        },
      },
    );
    expect(installedUi).toBe(true);

    const installedGraph = await page.evaluate(
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
              id: "apply-a",
              type: "ui.applyToViewport",
              position: { x: 320, y: 80 },
              data: { "default:asset": classId },
            },
            {
              id: "apply-b",
              type: "ui.applyToViewport",
              position: { x: 600, y: 80 },
              data: { "default:asset": classId },
            },
          ],
          edges: [
            {
              id: "e1",
              source: "begin",
              target: "apply-a",
              sourceHandle: "execOut",
              targetHandle: "execIn",
            },
            {
              id: "e2",
              source: "apply-a",
              target: "apply-b",
              sourceHandle: "execOut",
              targetHandle: "execIn",
            },
          ],
        },
      },
    );
    expect(installedGraph).toBe(true);

    await openMainScene(page);
    await expect(page.getByTestId("play-hud")).toHaveCount(0);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-hud-widget-ui-1:play-btn")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("play-hud-widget-ui-1:logo")).toBeVisible();
    await expect(page.getByTestId("play-hud-widget-ui-2:play-btn")).toBeVisible();
    await expect(page.getByTestId("play-hud-widget-ui-2:logo")).toBeVisible();
    await expect(page.getByTestId("play-hud-widget-ui-1:play-btn")).toHaveAttribute(
      "data-kind",
      "Button",
    );
    await expect(page.getByTestId("play-hud-widget-ui-1:logo")).toHaveAttribute(
      "data-kind",
      "Image",
    );

    const dispatched = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          dispatchPlayUiWidgetEvent?: (event: {
            instanceId: string;
            widgetId: string;
            kind: "click";
          }) => boolean;
        };
      };
      return (
        host.__babylonslateTest?.dispatchPlayUiWidgetEvent?.({
          instanceId: "ui-1",
          widgetId: "play-btn",
          kind: "click",
        }) ?? false
      );
    });
    expect(dispatched).toBe(true);
    await expect(page.getByTestId("play-log-tail")).toContainText("hud-clicked", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("play-hud-widget-ui-1:play-btn")).toHaveCount(0);
    await expect(page.getByTestId("play-hud-widget-ui-2:play-btn")).toBeVisible();
    await expect(page.getByTestId("play-hud-widget-ui-2:logo")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
  });

  test("UserInterface designer cannot nest itself", async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await createAsset(page, "UserInterface", "Panel");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await page.getByTestId("ui-add-widget").click();
    await expect(page.getByTestId("ui-widget-catalog")).toBeVisible();
    const nestedSlots = page.locator('[data-testid^="ui-add-widget-UserInterface-"]');
    await expect(nestedSlots).toHaveCount(1);
    await expect(nestedSlots).toContainText("Panel");
  });

  test("UserInterface designer paints a nested UserInterface subtree", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "UserInterface", "Panel");
    await page.locator('[data-asset-path="assets/Panel.ui.babasset"]').dblclick();
    const panelWorkspace = page.locator(
      '[data-testid="document-workspace-ui"]:visible',
    );
    await expect(panelWorkspace).toBeVisible();
    await panelWorkspace.getByTestId("ui-add-widget").click();
    await page.getByTestId("ui-add-widget-Button").click();
    await expect(
      panelWorkspace.locator('[data-testid^="ui-widget-button-"]'),
    ).toBeVisible();

    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    const hudWorkspace = page.locator(
      '[data-testid="document-workspace-ui"]:visible',
    );
    await expect(hudWorkspace).toBeVisible();
    await hudWorkspace.getByTestId("ui-add-widget").click();
    await expect(page.getByTestId("ui-widget-catalog")).toBeVisible();
    await page.locator('[data-testid^="ui-add-widget-UserInterface-"]').click();
    await expect(
      hudWorkspace.locator('[data-testid*="/button-"]'),
    ).toBeVisible();
    await expect(hudWorkspace.getByTestId("ui-gui-preview-error")).toHaveCount(0);
  });
});
