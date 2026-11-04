import { expect, test, type Page } from "@playwright/test";
import { importByExtension } from "../packages/assets/src/importers";
import { collectAssetDependencyMetadata } from "../packages/assets/src/asset-dependencies";
import { encodeAssetDocument, decodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeHasset, readHassetHeader } from "../packages/assets/src/hasset";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { buildFloatDdsCubeFixture } from "../packages/test-kit/src/environment-fixtures";
import { MAIN_SCENE_FILE } from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

/** The Environment Texture's face edge; no other cube the editor or Play uploads with pixels has it. */
const FACE_EDGE = 4;

/** Counts uploads of the Environment Texture's top level, one per cube face. */
async function countEnvironmentUploads(page: Page): Promise<void> {
  await page.addInitScript((edge) => {
    const counter = { uploads: 0 };
    (globalThis as unknown as { __environmentUploads: typeof counter }).__environmentUploads = counter;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const texImage2D = proto.texImage2D!;
    proto.texImage2D = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const target = args[0] as number;
      const cubeFace = target >= this.TEXTURE_CUBE_MAP_POSITIVE_X && target <= this.TEXTURE_CUBE_MAP_NEGATIVE_Z;
      if (cubeFace && args.length >= 9 && args[3] === edge && args[4] === edge && ArrayBuffer.isView(args[8])) counter.uploads += 1;
      return texImage2D.apply(this, args);
    };
  }, FACE_EDGE);
}

const uploads = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __environmentUploads: { uploads: number } }).__environmentUploads.uploads);

test("Play takes over the editor view's textures and hands them back on Stop instead of uploading them again", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Editor Play's leak report: what the handover holds for the editor's reload is not Play's leak.
  page.on("console", (message) => { if (/outlived it/.test(message.text())) errors.push(message.text()); });
  await countEnvironmentUploads(page);
  // The main Scene lights from an Environment Texture, which the editor's view and Play both sample.
  const [imported] = await importByExtension("Studio.dds", buildFloatDdsCubeFixture({ size: FACE_EDGE, color: [0, 1, 0, 1] }), {
    fileName: "Studio.dds",
    existingGuids: new Set(),
  });
  const files = await minimalProjectFiles();
  files.set("assets/Studio.hasset", await encodeHasset({
    header: {
      ...imported!,
      ...collectAssetDependencyMetadata(imported!.type, imported!.payload),
      engineVersion: "0.0.0",
      mode: "thin",
    },
    chunks: imported!.chunks,
  }));
  const decoded = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  const settings = decoded.payload.settings as Record<string, unknown>;
  settings.environmentSource = "texture";
  settings.environmentTextureGuid = imported!.guid;
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(decoded, {
    dependencies: [...readHassetHeader(files.get(MAIN_SCENE_FILE)!).dependencies, imported!.guid],
  }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  // Six faces, uploaded once by the editor's view.
  await expect.poll(() => uploads(page)).toBe(6);

  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId("play-canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as { __hapticPlayTest?: { tickIndex: () => number | null } }).__hapticPlayTest?.tickIndex() ?? -1),
  { timeout: 60_000 }).toBeGreaterThan(10);
  expect(await uploads(page), "Play uploaded the editor view's Environment Texture again").toBe(6);

  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  await waitForSceneViewportReady(page);
  expect(await uploads(page), "the editor's reloaded view uploaded Play's Environment Texture again").toBe(6);
  expect(errors).toEqual([]);
});
