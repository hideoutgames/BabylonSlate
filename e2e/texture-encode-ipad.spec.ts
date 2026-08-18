import path from "node:path";
import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

const fixtures = path.join(process.cwd(), "e2e/fixtures");

test.describe("Texture encode iPad", { tag: IPAD_TEST_TAG }, () => {
  test("import encode settles to compressed or usable source fallback", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();

    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([path.join(fixtures, "albedo.png")]);

    const albedo = page.locator('[data-asset-path="assets/albedo.babasset"]');
    await expect(albedo).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("importing-overlay")).toHaveCount(0);

    await expect(async () => {
      const state = await page.evaluate(() => {
        const api = (
          globalThis as {
            __babylonslateTest?: {
              textureEncodeState?: (path: string) => {
                compressionState: string | null;
                encodeError: string | null;
                hasPixels: boolean;
              } | null;
            };
          }
        ).__babylonslateTest;
        return api?.textureEncodeState?.("assets/albedo.babasset") ?? null;
      });
      expect(state?.hasPixels).toBe(true);
      expect([
        "compressed",
        "encode_failed",
        "fallback_uncompressed",
      ]).toContain(state?.compressionState);
      expect(state?.compressionState).not.toBe("encoding");
      expect(state?.compressionState).not.toBe("pending");
    }).toPass({ timeout: 60_000 });

    await albedo.dblclick();
    await expect(page.getByTestId("texture-preview")).toBeVisible();
    await expect(
      page.locator('[data-testid="texture-preview"] img'),
    ).toBeVisible();
  });
});
