import { expect, test } from "@playwright/test";
import type { runBakedParityProof } from "../apps/editor/src/testing/baked-parity-proof";

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

test("baked irradiance receiver matches realtime point-light shading within 3/255 on both backends", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?bakedParityProof=1");
  await page.waitForFunction(() => "__bakedParityProof" in window);
  const result = await page.evaluate(() =>
    (
      window as unknown as { __bakedParityProof: typeof runBakedParityProof }
    ).__bakedParityProof(),
  );
  await testInfo.attach("baked-parity", {
    body: JSON.stringify({ result, errors }),
    contentType: "application/json",
  });
  for (const entry of result) {
    await testInfo.attach(`${entry.backend}-frame`, {
      body: Buffer.from(entry.png.split(",")[1]!, "base64"),
      contentType: "image/png",
    });
    expect(entry.caps.halfFloat, `${entry.backend} half-float atlas`).toBe(
      true,
    );
    expect(
      entry.caps.halfLinear,
      `${entry.backend} half-float filtering`,
    ).toBe(true);
    expect(entry.atlas.ready, `${entry.backend} atlas upload ready`).toBe(
      true,
    );
    expect(entry.atlas.halfFloat, `${entry.backend} atlas format`).toBe(true);
    for (const label of ["pbrBaked", "celBaked"] as const)
      expect(
        entry.diagnostics[label].slateBaked,
        `${entry.backend} ${label} compiled without SLATE_BAKED`,
      ).toBe(true);
    for (const [realtime, baked, label] of [
      [entry.rows.pbrRealtime, entry.rows.pbrBaked, "PBR"],
      [entry.rows.celRealtime, entry.rows.celBaked, "CEL"],
    ] as const) {
      expect(baked.length, `${entry.backend} ${label} row`).toBe(
        realtime.length,
      );
      realtime.forEach((expected, index) =>
        expected.forEach((channel, c) =>
          expect(
            Math.abs(baked[index]![c]! - channel),
            `${entry.backend} ${label} pixel ${index} channel ${c}: ` +
              `baked ${baked[index]![c]} realtime ${channel}`,
          ).toBeLessThanOrEqual(3),
        ),
      );
    }
  }
  expect(errors).toEqual([]);
});
