import { expect, test, type Locator } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  PROJECT_FILE,
  type ProjectDocument,
} from "../packages/core/src/project";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMinimalTestProject } from "./minimal-project";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test(
  "Content Browser cards stay equal with padded status and lock overlays",
  {
    tag: IPAD_TEST_TAG,
  },
  async ({ page }) => {
    const files = await minimalProjectFiles();
    const project = JSON.parse(
      new TextDecoder().decode(files.get(PROJECT_FILE)),
    ) as ProjectDocument;
    project.settings.sourceControl.enabled = true;
    project.settings.textures.autoRequeueUncompressed = false;
    files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
    files.set(
      "assets/status.babasset",
      await encodeAssetDocument(
        {
          guid: "00000000-0000-4000-8000-000000000003",
          type: "Texture",
          name: "Status Texture With A Long Name",
          version: 1,
          payload: { compressionState: "encode_failed", usage: "albedo" },
        },
        { headerPayload: { compressionState: "encode_failed", usage: "albedo" } },
      ),
    );
    await openMinimalTestProject(page, files);
    await page.getByTestId("content-browser-new-folder").click();
    await page.getByTestId("content-browser-name-input").fill("Folder");
    await page.getByTestId("content-browser-name-confirm").click();
    await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(
      0,
    );
    await page.getByTestId("tree-row-assets").click();

    const folder = page.getByTestId("content-folder-assets/Folder");
    const scene = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    const texture = page.locator('[data-asset-path="assets/status.babasset"]');
    const status = texture.getByTestId(
      "texture-compression-00000000-0000-4000-8000-000000000003",
    );
    await expect(folder).toBeVisible();
    await expect(status).toHaveText("Encode failed");
    const initial = await bounds(texture);
    expect((await bounds(folder)).height).toBeCloseTo(initial.height, 1);
    expect((await bounds(scene)).height).toBeCloseTo(initial.height, 1);

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as {
                __babylonslateSourceControl?: { enabled: boolean };
              }
            ).__babylonslateSourceControl?.enabled,
        ),
      )
      .toBe(true);
    await page.evaluate(async () => {
      const sourceControl = (
        globalThis as {
          __babylonslateSourceControl: {
            fakeProvider: {
              addTheirs: (path: string, owner: string) => unknown;
            };
            refresh: () => Promise<void>;
          };
        }
      ).__babylonslateSourceControl;
      sourceControl.fakeProvider.addTheirs(
        "assets/status.babasset",
        "A Teammate With A Long Name",
      );
      await sourceControl.refresh();
    });
    const lock = texture.locator('[data-lock-state="theirs"]');
    await expect(lock).toHaveAttribute(
      "aria-label",
      "Locked By A Teammate With A Long Name",
    );

    for (const viewport of [
      page.viewportSize()!,
      { width: 820, height: 650 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(async () => {
        const textureBox = await bounds(texture);
        for (const tile of [folder, scene]) {
          const tileBox = await bounds(tile);
          expect(tileBox.width).toBeCloseTo(textureBox.width, 1);
          expect(tileBox.height).toBeCloseTo(textureBox.height, 1);
        }
        expect(textureBox.height).toBeCloseTo(initial.height, 1);
        const well = await bounds(
          texture.locator(".aspect-square > div").first(),
        );
        const statusBox = await bounds(status);
        const lockBox = await bounds(lock);
        // Both overlays clear the colored stroke and cannot cover each other.
        expect(statusBox.x).toBeGreaterThanOrEqual(well.x + 4);
        expect(statusBox.y).toBeGreaterThanOrEqual(well.y + 4);
        expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(
          lockBox.x - 2,
        );
        expect(lockBox.x + lockBox.width).toBeLessThanOrEqual(
          well.x + well.width - 4,
        );
        expect(lockBox.y).toBeCloseTo(statusBox.y, 1);
        expect(lockBox.y + lockBox.height).toBeLessThan(well.y + well.height);
        expect(lockBox.x + lockBox.width / 2).toBeGreaterThan(
          well.x + well.width / 2,
        );
      }).toPass();
    }
  },
);
