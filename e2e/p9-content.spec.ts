import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import {
  addMaterialPaletteNode,
  compileMaterialPreview,
  connectMaterialPins,
  guidForPath,
  importAlbedoTexture,
  pickMaterialNodeTexture,
} from "./material-graph";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";
import { previewPlacementScene } from "./preview-scene-fixture";
import { createMeshComponent } from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator(
      '[data-testid="document-tab"][data-document-kind="content-browser"]',
    )
    .click();
  await expect(
    page.getByTestId("document-workspace-content-browser"),
  ).toBeVisible();
}

async function createAsset(
  page: Page,
  type:
    | "Sprite"
    | "SpriteAnimation"
    | "AnimationGraph"
    | "Material"
    | "MaterialFunction",
  name: string,
): Promise<void> {
  await createContentBrowserAsset(page, type, name);
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
      const fire = (type: string, pointerId: number, x: number, y: number) => {
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

type MaterialVisualSnapshot = {
  actorId: string;
  meshUniqueId: number;
  materialUniqueId: number | null;
  materialInputs: Record<string, number[]>;
};

async function materialVisual(
  page: Page,
  viewport: "scene" | "prefab",
  actorId: string,
): Promise<MaterialVisualSnapshot | null> {
  return page.evaluate(
    ({ viewport, actorId }) => {
      const host = globalThis as unknown as {
        __babylonslateViewportTest?: {
          sceneVisuals: () => MaterialVisualSnapshot[];
        };
        __babylonslatePrefabViewportTest?: {
          visuals: () => MaterialVisualSnapshot[];
        };
      };
      const visuals =
        viewport === "scene"
          ? host.__babylonslateViewportTest?.sceneVisuals()
          : host.__babylonslatePrefabViewportTest?.visuals();
      return visuals?.find((visual) => visual.actorId === actorId) ?? null;
    },
    { viewport, actorId },
  );
}

test.describe("P9 content systems", () => {

  test("Saving a Material refreshes existing Scene and Prefab mesh shaders", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    const materialPath = "assets/RefreshMaterial.material.babasset";
    await createAsset(page, "Material", "RefreshMaterial");
    const materialGuid = await guidForPath(page, materialPath);
    expect(materialGuid).not.toBe("");
    await openMainScene(page);
    const scene = previewPlacementScene(materialGuid);
    expect(
      await page.evaluate(async (nextScene) => {
        const host = globalThis as unknown as {
          __babylonslateTest?: {
            setActiveSceneContent: (
              scene: typeof nextScene,
            ) => Promise<boolean>;
          };
        };
        return (
          host.__babylonslateTest?.setActiveSceneContent(nextScene) ?? false
        );
      }, scene),
    ).toBe(true);
    await expect
      .poll(() => materialVisual(page, "scene", "material-actor"), {
        timeout: 15_000,
      })
      .toMatchObject({ materialInputs: { baseColor: [0.8, 0.8, 0.8] } });
    const beforeScene = await materialVisual(page, "scene", "material-actor");
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("graph-panel")).toBeVisible({
      timeout: 15_000,
    });
    const mesh = createMeshComponent("refresh-prefab", "box");
    mesh.properties.materialGuid = materialGuid;
    expect(
      await page.evaluate(
        async (components) => {
          const host = globalThis as unknown as {
            __babylonslateTest?: {
              setMainGraphComponents: (
                value: typeof components,
              ) => Promise<boolean>;
            };
          };
          return (
            host.__babylonslateTest?.setMainGraphComponents(components) ?? false
          );
        },
        [mesh],
      ),
    ).toBe(true);
    await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
    await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();
    await expect
      .poll(() => materialVisual(page, "prefab", "refresh-prefab"), {
        timeout: 15_000,
      })
      .toMatchObject({ materialInputs: { baseColor: [0.8, 0.8, 0.8] } });
    const beforePrefab = await materialVisual(page, "prefab", "refresh-prefab");
    await saveAllIfEnabled(page);
    await openAssetFromBrowser(page, materialPath);
    await page
      .getByTestId("material-graph-editor")
      .locator('.react-flow__node[data-id="baseColor"]')
      .click();
    await page.getByTestId("property-color").fill("#ff0000");
    await saveAllIfEnabled(page);
    await openMainScene(page);
    await expect
      .poll(
        async () =>
          (await materialVisual(page, "scene", "material-actor"))
            ?.materialInputs?.baseColor,
        { timeout: 15_000 },
      )
      .toEqual([1, 0, 0]);
    const afterScene = await materialVisual(page, "scene", "material-actor");
    expect(afterScene?.meshUniqueId).toBe(beforeScene?.meshUniqueId);
    expect(afterScene?.materialUniqueId).not.toBe(
      beforeScene?.materialUniqueId,
    );
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
    await expect
      .poll(
        async () =>
          (await materialVisual(page, "prefab", "refresh-prefab"))
            ?.materialInputs?.baseColor,
        { timeout: 15_000 },
      )
      .toEqual([1, 0, 0]);
    const afterPrefab = await materialVisual(page, "prefab", "refresh-prefab");
    expect(afterPrefab?.meshUniqueId).toBe(beforePrefab?.meshUniqueId);
    expect(afterPrefab?.materialUniqueId).not.toBe(
      beforePrefab?.materialUniqueId,
    );
  });
  test("Font editor sample preview uses the compiled stack", async ({
    page,
  }) => {
    await openTestProject(page);
    await showContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles({
        name: "display.woff2",
        mimeType: "font/woff2",
        buffer: await readFile(path.join(
          process.cwd(),
          "packages/ui/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
        )),
      });
    await expect(
      page.locator('[data-asset-path="assets/display.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .locator('[data-asset-path="assets/display.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-font")).toBeVisible();
    const sample = page.getByTestId("font-sample-preview");
    await expect(sample).toBeVisible();
    await expect(sample).toHaveAttribute("data-fonts-ready", "true");
    await expect(sample).toContainText("The quick brown fox");
    const family = await sample.evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
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
    await expect(page.getByTestId("settings-modal-category-input")).toHaveCount(0);
  });

  test("Sprite, AnimationGraph, and Material open document workspaces", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "Sprite", "Hero");
    await page
      .locator('[data-asset-path="assets/Hero.sprite.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-sprite")).toBeVisible();
    await expect(page.getByTestId("sprite-preview")).toBeVisible();
    await expect(page.getByTestId("sprite-editor")).toBeVisible();
    await expect(page.getByTestId("property-texture")).toBeVisible();

    await createAsset(page, "SpriteAnimation", "Walk");
    await page
      .locator('[data-asset-path="assets/Walk.spriteanim.babasset"]')
      .dblclick();
    await expect(
      page.getByTestId("document-workspace-sprite-animation"),
    ).toBeVisible();
    await expect(page.getByTestId("sprite-animation-preview")).toBeVisible();
    await expect(page.getByTestId("sprite-animation-play")).toBeVisible();
    await expect(page.getByTestId("sprite-animation-editor")).toBeVisible();

    await createAsset(page, "AnimationGraph", "Loco");
    await page
      .locator('[data-asset-path="assets/Loco.anim.babasset"]')
      .dblclick();
    await expect(
      page.getByTestId("document-workspace-anim-graph"),
    ).toBeVisible();
    await expect(page.getByTestId("anim-editor-mode-bar")).toBeVisible();
    await expect(
      page.getByTestId("anim-editor-mode-state-machine"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId("anim-dock-surface-state-machine"),
    ).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
    await expect(
      animStateMachine(page).getByTestId("anim-graph-parameters"),
    ).toBeVisible();
    await expect(page.getByTestId("anim-graph-add-state")).toBeVisible();

    await createAsset(page, "Material", "Surface");
    await page
      .locator('[data-asset-path="assets/Surface.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("material-graph-editor")).toBeVisible();
    await expect(page.getByTestId("material-preview-canvas")).toBeVisible();
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
    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-material-preview")).toBeVisible();
    await expect(page.getByTestId("windows-menu-material-compiler-results")).toBeVisible();
    await closeWindowsMenu(page);

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
      page
        .getByTestId("material-preview-overlay")
        .getByTestId("material-render"),
    ).toHaveCount(0);
    await expect(page.getByTestId("material-preview-status")).toHaveCount(0);
    await expect(page.getByTestId("material-preview-custom-mesh")).toHaveCount(
      0,
    );
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
    await expect(
      page.getByTestId("material-preview-mesh-picker"),
    ).toBeVisible();
    await page.getByTestId("search-item-__none__").click();
    await expect(page.getByTestId("material-preview-mesh-picker")).toHaveCount(
      0,
    );

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
    const radiusBefore = Number(
      await canvas.getAttribute("data-camera-radius"),
    );
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

  test("Custom GLSL node compiles a function body in the Material editor", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openMinimalTestProject(page);
    await createAsset(page, "Material", "Glsl");
    await page
      .locator('[data-asset-path="assets/Glsl.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("material-details-panel")).toBeVisible();
    await addMaterialPaletteNode(page, "Custom GLSL", "custom.glsl");
    await page.getByTestId("custom-glsl-output-add").click();
    await page.getByTestId("custom-glsl-output-add-menu").getByTestId("search-item-float").click();
    const outputName = page.getByRole("textbox", { name: "Output 1 name", exact: true });
    await expect(outputName).toBeFocused();
    await outputName.fill("Mask");
    await outputName.press("Enter");
    const glsl = page.getByTestId("material-node-glsl");
    await expect(glsl).toBeVisible();
    await expect(
      page.getByTestId("material-node-glsl-signature"),
    ).toContainText("Return the primary output");
    await glsl.click();
    const glslEditor = page.getByRole("textbox", { name: "GLSL Function Body" });
    await glslEditor.fill("norm");
    await glslEditor.press("End");
    await glslEditor.press("Control+Space");
    await expect(page.getByRole("option", { name: "normalize", exact: true })).toBeVisible();
    await glslEditor.press("Escape");
    await glslEditor.fill("#define X 1");
    await page.getByTestId("material-node-glsl-done").click();
    await expect(
      page.getByTestId("material-diagnostic-material.customGlsl"),
    ).toBeVisible({ timeout: 10_000 });
    await glsl.click();
    await glslEditor.fill("Mask = 0.5;\nreturn A + B;");
    await page.screenshot({ path: testInfo.outputPath("custom-glsl-editor.png") });
    await page.getByTestId("material-node-glsl-done").click();
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
    await source.dragTo(target);
    await expect(graph.locator('.react-flow__edge[data-id*=":out:output:metallic"]')).toHaveCount(1);
    await graph.locator('.react-flow__node[data-id^="custom.glsl-"] [data-handleid^="p_"][data-handlepos="right"]').dragTo(graph.locator('.react-flow__node[data-id="output"] [data-handleid="roughness"][data-handlepos="left"]'));
    await expect(graph.locator('.react-flow__edge[data-id$=":output:roughness"]')).toHaveCount(1);
    await expect(page.getByTestId("material-render")).toBeEnabled();
    await page.getByTestId("material-render").click();
    await expect(page.getByTestId("material-preview-canvas")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 15_000 },
    );
    await graph.locator('.react-flow__node[data-id^="custom.glsl-"]').click();
    await glsl.click();
    await glslEditor.fill("Mask = 0.5;\nreturn UndefinedSymbol;");
    await page.getByTestId("material-node-glsl-done").click();
    await expect(page.getByTestId("material-render")).toBeEnabled();
    await page.getByTestId("material-render").click();
    await expect(page.getByTestId("material-diagnostic-material.compile.glsl")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("material-diagnostic-material.compile.glsl")).toContainText("line 2");
    await glsl.click();
    await glslEditor.fill("Mask = 0.5;\nreturn A + B;");
    await page.getByTestId("material-node-glsl-done").click();
    await expect(page.getByTestId("material-render")).toBeEnabled();
    await page.getByTestId("material-render").click();
    await expect(page.getByTestId("material-preview-canvas")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  });

  test("Texture Parameter wires into Texture Sample for a ready preview", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openMinimalTestProject(page);
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
    const bloomGuid = await guidForPath(page, "assets/Bloom.material.babasset");
    expect(bloomGuid.length).toBeGreaterThan(0);
    await page.getByTestId(`search-item-${bloomGuid}`).click();
    await expect(
      page.getByTestId("scene-post-process-0-material"),
    ).toContainText("Bloom");
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
    await expect(page.getByTestId("setting-post-processing")).toBeDisabled();
    await page.getByRole("switch", { name: "Override Project Rendering", exact: true }).check();
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
    await expect(
      page.getByTestId("scene-post-process-0-material"),
    ).toContainText("Bloom");
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
    await expect(
      page.getByTestId("material-function-graph-editor"),
    ).toBeVisible();
    await expect(page.getByTestId("material-function-inputs")).toBeVisible();
    await expect(page.getByTestId("material-function-outputs")).toBeVisible();
  });
});
