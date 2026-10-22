import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  createText2DComponent,
  identitySerializedTransform,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
} from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createFontPayload } from "../packages/assets/src/font-payload";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { previewPhysicsScene, previewManyLightsScene } from "./preview-scene-fixture";
import { expectGreenIllumination, expectSpheresRollDownhill, setPreviewScene } from "./preview-parity";

const COLD_FONT_GUID = "00000000-0000-4000-8000-0000000000f1";
const COLD_FONT_FAMILY = "Cold Load Onest";
const COLD_GLYPHS = 10;
type Text2DLayout = { name: string; fontStack: string; width: number };

/**
 * A Font used by explicit and project-default 2D Text on a Scene Layer. Each
 * pair draws ten "0"s and ten "1"s: Onest's "1" is far narrower than its "0",
 * while generic fallback faces draw both digits at one width.
 */
async function coldFontProject(fontBytes: Uint8Array) {
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  const font = createFontPayload(COLD_FONT_FAMILY, { representations: { source: true } }) as unknown as Record<string, unknown>;
  files.set("assets/ColdLoadOnest.hasset", await encodeAssetDocument(
    { guid: COLD_FONT_GUID, type: "Font", name: COLD_FONT_FAMILY, version: versions.currentVersion("Font") || 1, payload: font },
    { headerPayload: font, extraChunks: [{ id: "source", kind: "font", mime: "font/woff2", data: fontBytes }] },
  ));
  const layerGuid = "00000000-0000-4000-8000-0000000000f2";
  const layer = createDefaultSceneLayer();
  // One actor, so each Text mesh is named after its component.
  layer.actors = [createActor("cold-font-texts", "Cold Font Texts", {
    classId: "SceneLayerActor",
    components: (["explicit", "default"] as const).flatMap((route, row) =>
      (["narrow", "wide"] as const).map((digits, column) => {
        const text = createText2DComponent(`${route}-${digits}`);
        text.properties = {
          ...text.properties, text: (digits === "narrow" ? "1" : "0").repeat(COLD_GLYPHS), size: 48,
          fontAssetGuid: route === "explicit" ? COLD_FONT_GUID : null, wrapWidth: 0, wrapHeight: 0,
        };
        text.transform = { ...identitySerializedTransform(), position: [column * 8 - 4, 3 - row * 6, 0] };
        return text;
      })),
  })];
  files.set("assets/ColdFont.scenelayer.hasset", await encodeAssetDocument({ guid: layerGuid, type: "SceneLayer", name: "ColdFont",
    version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown> }));
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main",
    version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown> }));
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.fonts.defaultFontGuid = COLD_FONT_GUID;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  return files;
}

/** Per-glyph "0" minus "1" advance with the Font loaded under its own probe family, and with the generic fallback alone. */
async function referenceDigitSpread(page: Page, fontBytes: Uint8Array) {
  return page.evaluate(async (bytes) => {
    const face = new FontFace("Cold Load Probe", new Uint8Array(bytes));
    document.fonts.add(face);
    await face.load();
    const context = document.createElement("canvas").getContext("2d")!;
    const spread = (stack: string) => {
      context.font = `normal 400 48px ${stack}`;
      return context.measureText("0").width - context.measureText("1").width;
    };
    const result = { custom: spread('"Cold Load Probe"'), fallback: spread("sans-serif") };
    document.fonts.delete(face);
    return result;
  }, [...fontBytes]);
}

/**
 * The laid-out width of drawn glyph cells. Both runs of a pair have the same
 * glyph count, so per-cell padding cancels and their difference is the face's
 * own advances: a silent fallback face gives about zero.
 */
async function expectCustomFaceLaidOut(read: () => Promise<Text2DLayout[]>, perGlyphSpread: number) {
  let rows: Text2DLayout[] = [];
  const ids = ["explicit-narrow", "explicit-wide", "default-narrow", "default-wide"];
  const row = (id: string) => rows.find((entry) => entry.name.endsWith(`|${id}`) && entry.width > 0);
  await expect.poll(async () => {
    rows = await read();
    return ids.every((id) => row(id)) || JSON.stringify(rows);
  }, { timeout: 30_000 }).toBe(true);
  for (const route of ["explicit", "default"]) {
    const spread = row(`${route}-wide`)!.width - row(`${route}-narrow`)!.width;
    // Glyph cells are whole pixels, so each of the ten glyphs may round by up to one.
    expect(Math.abs(spread - COLD_GLYPHS * perGlyphSpread), `${route} Font text: ${JSON.stringify(rows)}`)
      .toBeLessThanOrEqual(COLD_GLYPHS);
  }
}

async function previewSlotMaterialNames(page: Page): Promise<string[]> {
  const root = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-root");
  return root.evaluate(() => {
    const host = globalThis as unknown as {
      __hapticPlayerTest?: {
        meshMaterialNames?: () => string[];
        visuals: () => Array<{ materialName: string | null }>;
      };
    };
    const named = host.__hapticPlayerTest?.meshMaterialNames?.() ?? [];
    if (named.length > 0) return named;
    return (host.__hapticPlayerTest?.visuals() ?? [])
      .map((visual) => visual.materialName)
      .filter((name): name is string => typeof name === "string");
  });
}

/**
 * Count slim-stub red and Babylon error-sampler magenta among non-clear pixels.
 * With `texel`, only pixels near that sampled color count as albedo.
 */
async function previewCanvasPixelStats(
  page: Page,
  texel?: readonly [number, number, number],
): Promise<
  | { ok: false; reason: string; width?: number; height?: number }
  | {
      ok: true;
      total: number;
      albedo: number;
      redStub: number;
      magenta: number;
      width: number;
      height: number;
    }
> {
  const canvas = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-canvas");
  return canvas.evaluate((node, texel) => {
    if (!(node instanceof HTMLCanvasElement)) {
      return { ok: false as const, reason: "no-canvas" };
    }
    const width = node.width;
    const height = node.height;
    if (width < 2 || height < 2) {
      return { ok: false as const, reason: "tiny", width, height };
    }
    const dst = document.createElement("canvas");
    dst.width = width;
    dst.height = height;
    const ctx = dst.getContext("2d");
    if (!ctx) return { ok: false as const, reason: "2d" };
    ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    let albedo = 0;
    let redStub = 0;
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a < 8 || r + g + b < 24) continue;
      // Default Empty sky is blue; do not let it drown a small red character.
      if (b > 90 && b > r + 15 && b > g) continue;
      if (r > 200 && g < 40 && b < 40) {
        redStub += 1;
        continue;
      }
      if (r > 200 && g < 40 && b > 200) {
        magenta += 1;
        continue;
      }
      if (texel) {
        if (Math.abs(r - texel[0]) < 45 && Math.abs(g - texel[1]) < 45 && Math.abs(b - texel[2]) < 45) {
          albedo += 1;
        }
        continue;
      }
      // Kenney albedo is tan/cloth (green channel present). Error-sampler
      // checkerboard is red/black/magenta; grey AA must not count as success.
      if (g >= 50 && r >= 40) {
        albedo += 1;
      }
    }
    const total = albedo + redStub + magenta;
    return { ok: true as const, total, albedo, redStub, magenta, width, height };
  }, texel);
}

test.describe("P14 Preview Build", () => {
  test("Preview Build rolls all eight legacy duplicated spheres down an angled cube", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await setPreviewScene(page, previewPhysicsScene());
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expectSpheresRollDownhill(root);
    await page.getByTestId("preview-build-close").click();
  });

  test("lights beyond the fourth illuminate Scene Viewport, Play, and Preview Build", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await setPreviewScene(page, previewManyLightsScene());
    await expectGreenIllumination(page.getByTestId("viewport-canvas"));
    await clickPlayAndWaitForOverlay(page);
    await expectGreenIllumination(page.getByTestId("play-canvas"));
    await page.getByTestId("play-overlay-close").click();
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    await waitForPreviewBuildBoot(page);
    await expectGreenIllumination(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"));
    await page.getByTestId("preview-build-close").click();
  });

  test("custom Fonts lay out their own faces on a cold load in Play and Preview Build", async ({ page }) => {
    test.setTimeout(180_000);
    const fontBytes = new Uint8Array(await readFile(path.join(process.cwd(), "engine-content/fonts/Onest/Onest-Latin-Variable.woff2")));
    const probe = await page.context().newPage();
    const reference = await referenceDigitSpread(probe, fontBytes);
    await probe.close();
    // Otherwise a silent fallback could not be told apart from the Font.
    expect(Math.abs(reference.custom - reference.fallback)).toBeGreaterThan(4);
    await openMinimalTestProject(page, await coldFontProject(fontBytes));
    await openMainScene(page);
    // Play must register the face itself: nothing in the editor has loaded it yet.
    expect(await page.evaluate((family) => [...document.fonts].some((face) => face.family.replace(/"/g, "") === family), COLD_FONT_FAMILY)).toBe(false);
    await clickPlayAndWaitForOverlay(page);
    await expectCustomFaceLaidOut(() => page.evaluate(() =>
      (globalThis as unknown as { __hapticPlayTest?: { text2dLayouts: () => Text2DLayout[] } })
        .__hapticPlayTest?.text2dLayouts() ?? []), reference.custom);
    await page.getByTestId("play-overlay-close").click();
    // The Preview Build player is a fresh document, so its faces load cold as in a served export.
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expectCustomFaceLaidOut(() => root.evaluate(() =>
      (globalThis as unknown as { __hapticPlayerTest?: { text2dLayouts: () => Text2DLayout[] } })
        .__hapticPlayerTest?.text2dLayouts() ?? []), reference.custom);
    await page.getByTestId("preview-build-close").click();
  });

  test("a Font that cannot load stops Play with an error naming it instead of drawing a fallback", async ({ page }) => {
    test.setTimeout(120_000);
    // A WOFF2 signature with no font data.
    const broken = new Uint8Array(await readFile(path.join(process.cwd(), "e2e/fixtures/display.woff2")));
    await openMinimalTestProject(page, await coldFontProject(broken));
    await openMainScene(page);
    await page.getByTestId("play-preview").click();
    // The failed Scene Layer load ends the session, and its report names the Font.
    const report = page.getByTestId("preview-session-report");
    await expect(report).toBeVisible({ timeout: 60_000 });
    for (const toggle of await report.getByTestId("session-report-group-toggle").all()) await toggle.click();
    await expect(report.getByTestId("session-report-row").filter({ hasText: `Font "${COLD_FONT_FAMILY}" failed to load` }).first())
      .toBeVisible();
  });

  test("Preview Build Play from Scene packs the open tab; off packs startup", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await createContentBrowserAsset(page, "Scene", "LevelTwo");
    const guids = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __hapticTest?: {
          guidForPath: (path: string) => string | null;
          projectStartupSceneGuid: () => string;
        };
      };
      return {
        open:
          host.__hapticTest?.guidForPath(
            "assets/LevelTwo.scene.hasset",
          ) ?? "",
        startup: host.__hapticTest?.projectStartupSceneGuid() ?? "",
      };
    });
    expect(guids.open).not.toBe(guids.startup);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expect(root).toHaveAttribute("data-startup-scene", guids.open, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("play-from-scene-toggle").click();
    await page.getByTestId("play-preview").click();
    const startupRoot = await waitForPreviewBuildBoot(page);
    await expect(startupRoot).toHaveAttribute("data-startup-scene", guids.startup, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
  });

  test("Preview Build binds the template PBR Mannequin material without the error sampler", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expect
      .poll(async () => Number((await root.getAttribute("data-ticks")) ?? "0"), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const names = await previewSlotMaterialNames(page);
          // Basic 3D explicitly assigns its authored PBR graph material.
          return names.some((name) => name.startsWith("material:"))
            ? "bound"
            : names.join(",") || "none";
        },
        { timeout: 30_000 },
      )
      .toBe("bound");

    await expect
      .poll(
        async () => {
          const stats = await previewCanvasPixelStats(page);
          if (!stats.ok || stats.total < 50) {
            return `wait:${JSON.stringify(stats)}`;
          }
          const bad = stats.redStub + stats.magenta;
          return stats.albedo > bad && bad / stats.total < 0.25
            ? "ok"
            : `albedo:${stats.albedo}/red:${stats.redStub}/magenta:${stats.magenta}/total:${stats.total}`;
        },
        { timeout: 30_000 },
      )
      .toBe("ok");
    await page.getByTestId("preview-build-close").click();
  });
});
