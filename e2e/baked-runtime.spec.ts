import { expect, test } from "@playwright/test";
import { bakedAtlasGpuBytes } from "../packages/render/src/baked-gpu-cost.ts";
import type { runBakedRuntimeProof } from "../apps/editor/src/testing/baked-runtime-proof";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      ...(process.platform === "linux"
        ? [
            "--enable-features=Vulkan",
            "--use-vulkan=swiftshader",
            "--disable-vulkan-surface",
          ]
        : []),
    ],
  },
});

test("uploads physical irradiance with receiver-local UV2 and releases shared atlases on both backends", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?bakedRuntimeProof=1");
  await page.waitForFunction(() => "__bakedRuntimeProof" in window);
  const result = await page.evaluate(() =>
    (
      window as unknown as { __bakedRuntimeProof: typeof runBakedRuntimeProof }
    ).__bakedRuntimeProof(),
  );
  await testInfo.attach("baked-runtime", {
    body: JSON.stringify({ result, errors }),
    contentType: "application/json",
  });
  for (const entry of result) {
    for (const [name, value] of Object.entries(entry.captures))
      await testInfo.attach(`${entry.backend}-${name}`, {
        body: Buffer.from(value.png.split(",")[1]!, "base64"),
        contentType: "image/png",
      });
    expect(entry.shared).toBe(true);
    expect(entry.restored).toBe(true);
    // The budget scene shares the atlas (same sha), so its rejection lands
    // at the geometry reserve; 150 bytes of headroom is below the 176-byte
    // WebGPU geometry reservation either way.
    expect(entry.alignmentRejected).toBe(entry.backend === "webgpu");
    // RGBA16F upload: 32×32×8 bytes; WebGPU retains a same-size staging
    // buffer because 32·8 lands on its 256-byte row alignment.
    const atlasGpuBytes = bakedAtlasGpuBytes(
      32,
      32,
      entry.backend === "webgpu",
    );
    // Per-scene remapped geometry: indices 24 + position 72 + packed 6
    // (WebGPU 4-byte-aligns to 8) + uv2 48, plus WebGPU's 24-byte aligned
    // copy of the 1-byte packed stride — 150 on WebGL2, 176 on WebGPU.
    const geometryBytes = entry.backend === "webgpu" ? 176 : 150;
    expect(entry.bytesBefore).toEqual({
      managedBytes: atlasGpuBytes + geometryBytes * 2,
      quarantined: false,
    });
    expect(entry.bytesAwaitingRelease).toBe(
      // WebGPU defers releases to the next endFrame; the remaining capture's
      // endFrame already flushed the first scene's geometry.
      entry.backend === "webgpu" ? atlasGpuBytes + geometryBytes : 0,
    );
    expect(entry.bytesAfter).toEqual({ managedBytes: 0, quarantined: false });
    expect(entry.atlasReleased).toBe(true);
    for (const [actual, expected] of [
      [entry.captures.left.bottom, [51, 0, 0, 255]],
      [entry.captures.left.top, [0, 0, 153, 255]],
      [entry.captures.right.bottom, [0, 102, 0, 255]],
      [entry.captures.right.top, [204, 204, 0, 255]],
      [entry.captures.remaining.bottom, [0, 102, 0, 255]],
      [entry.captures.remaining.top, [204, 204, 0, 255]],
    ] as const)
      actual.forEach((value, index) =>
        expect(
          Math.abs(value! - expected[index]!),
          `${entry.backend} raw E/UV pixel`,
        ).toBeLessThanOrEqual(2),
      );
  }
  expect(errors).toEqual([]);
});
