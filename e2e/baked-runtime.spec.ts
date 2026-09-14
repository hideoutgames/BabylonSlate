import { expect, test } from "@playwright/test";
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
    expect(entry.alignmentRejected).toBe(entry.backend === "webgpu");
    expect(entry.bytesBefore).toEqual({
      managedBytes: entry.backend === "webgpu" ? 8496 : 4396,
      quarantined: false,
    });
    expect(entry.bytesAwaitingRelease).toBe(
      entry.backend === "webgpu" ? 8344 : 0,
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
