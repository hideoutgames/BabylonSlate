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
    for (const label of ["pbrRealtime", "celRealtime"] as const)
      expect(
        entry.diagnostics[label].lightDefines,
        `${entry.backend} ${label} compiled without a realtime light`,
      ).toBeGreaterThanOrEqual(1);
    expect(
      entry.diagnostics.pbrBaked.bakedInjection,
      `${entry.backend} pbrBaked missing the diffuseBase injection`,
    ).toBe(true);
    expect(
      entry.diagnostics.celBaked.bakedTexelSamples,
      `${entry.backend} celBaked missing the baked texel sample`,
    ).toBeGreaterThan(0);
    // Environment group: a uniform linear-radiance cube and its E = PI * C
    // atlas must agree on dielectric diffuse AND keep metallic specular.
    for (const label of ["pbrEnvBaked", "pbrEnvSpecBaked"] as const) {
      expect(
        entry.diagnostics[label].slateBakedEnv,
        `${entry.backend} ${label} compiled without SLATE_BAKED_ENV`,
      ).toBe(true);
      expect(
        entry.diagnostics[label].irradianceGate,
        `${entry.backend} ${label} missing the finalIrradiance gate`,
      ).toBe(true);
    }
    for (const label of ["pbrEnvRealtime", "pbrEnvSpecRealtime"] as const)
      expect(
        entry.diagnostics[label].slateBakedEnv,
        `${entry.backend} ${label} unexpectedly compiled with SLATE_BAKED_ENV`,
      ).toBe(false);
    expect(
      Math.max(...entry.rows.pbrEnvSpecBaked[Math.floor(entry.rows.pbrEnvSpecBaked.length / 2)]!.slice(0, 3)),
      `${entry.backend} pbrEnvSpecBaked centre pixel — environment specular lost`,
    ).toBeGreaterThanOrEqual(40);
    for (const [realtime, baked, label] of [
      [entry.rows.pbrRealtime, entry.rows.pbrBaked, "PBR"],
      [entry.rows.celRealtime, entry.rows.celBaked, "CEL"],
      [entry.rows.pbrEnvRealtime, entry.rows.pbrEnvBaked, "PBR env"],
      [entry.rows.pbrEnvSpecRealtime, entry.rows.pbrEnvSpecBaked, "PBR env spec"],
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
