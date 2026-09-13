import { expect, test, type Page } from "@playwright/test";
import { importByExtension } from "../packages/assets/src/importers";
import {
  encodeAssetDocument,
  decodeAssetDocument,
} from "../packages/assets/src/asset-document";
import {
  encodeBabasset,
  readBabassetHeader,
} from "../packages/assets/src/babasset";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { buildFloatDdsCubeFixture } from "../packages/test-kit/src/environment-fixtures";
import { MAIN_SCENE_FILE } from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { expectGreenIllumination } from "./preview-parity";

async function greenEnv(page: Page) {
  // Numeric RGBD green, exactly linear [0,1,0]; no generated artwork.
  const png = new Uint8Array(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgb(0,255,0)";
      context.fillRect(0, 0, 1, 1);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((result) => resolve(result!)),
      );
      return [...new Uint8Array(await blob.arrayBuffer())];
    }),
  );
  const polynomial = Object.fromEntries(
    ["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"].map((key) => [
      key,
      [0, key.length === 2 && key[0] === key[1] ? 1 : 0, 0],
    ]),
  );
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      width: 1,
      imageType: "image/png",
      irradiance: polynomial,
      specular: {
        mipmaps: Array.from({ length: 6 }, (_, face) => ({
          position: png.length * face,
          length: png.length,
        })),
      },
    }),
  );
  const bytes = new Uint8Array(9 + header.length + png.length * 6);
  bytes.set([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);
  bytes.set(header, 8);
  for (let face = 0; face < 6; face++)
    bytes.set(png, 9 + header.length + png.length * face);
  return bytes;
}

test("imports HDR environment cubes and consumes linear faces and roughness mips in Scene and Play", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/__test_identity");
  const evidence = [];
  for (const container of ["dds", "env"] as const) {
    const source =
      container === "dds"
        ? buildFloatDdsCubeFixture({ color: [0, 1, 0, 1] })
        : await greenEnv(page);
    const [imported] = await importByExtension(`Studio.${container}`, source, {
      fileName: `Studio.${container}`,
      existingGuids: new Set(),
    });
    const files = await minimalProjectFiles();
    files.set(
      "assets/Studio.babasset",
      await encodeBabasset({
        header: { ...imported!, engineVersion: "0.0.0", mode: "thin" },
        chunks: imported!.chunks,
      }),
    );
    const decoded = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
    const scene = decoded.payload;
    const settings = scene.settings as Record<string, unknown>;
    settings.environmentTextureGuid = imported!.guid;
    settings.environmentColor = [0, 0, 0];
    files.set(
      MAIN_SCENE_FILE,
      await encodeAssetDocument(
        { ...decoded, payload: scene },
        {
          dependencies: [
            ...readBabassetHeader(files.get(MAIN_SCENE_FILE)!).dependencies,
            imported!.guid,
          ],
        },
      ),
    );
    await openMinimalTestProject(page, files);
    await openMainScene(page);
    await expectGreenIllumination(page.getByTestId("viewport-canvas"));
    const samples = await page.evaluate(async () => {
      const host = window as unknown as {
        __babylonslateViewportTest: {
          environmentTextureSamples(): Promise<{
            isCube: boolean;
            gammaSpace: boolean;
            size: { width: number; height: number };
            samples: Array<{
              face: number;
              level: number;
              type: string;
              values: number[];
            }>;
          }>;
        };
      };
      return host.__babylonslateViewportTest.environmentTextureSamples();
    });
    expect(samples.isCube).toBe(true);
    expect(samples.gammaSpace).toBe(false);
    expect(samples.size).toEqual({
      width: container === "dds" ? 2 : 1,
      height: container === "dds" ? 2 : 1,
    });
    expect(samples.samples).toHaveLength(container === "dds" ? 4 : 2);
    for (const sample of samples.samples) {
      const unit = sample.type === "Uint8Array" ? 255 : 1;
      expect(sample.values[0]).toBeCloseTo(0, 4);
      expect(sample.values[1]).toBeCloseTo(unit, 4);
      expect(sample.values[2]).toBeCloseTo(0, 4);
    }
    evidence.push({ container, samples });
    await clickPlayAndWaitForOverlay(page);
    await expectGreenIllumination(page.getByTestId("play-canvas"));
    await page.getByTestId("play-overlay-close").click();
    await openAssetFromBrowser(page, "assets/Studio.babasset");
    await expect(
      page.getByText("Environment Cube", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Downsample", { exact: true })).toHaveCount(0);
  }
  await testInfo.attach("environment-cubes", {
    body: JSON.stringify(evidence),
    contentType: "application/json",
  });
});
