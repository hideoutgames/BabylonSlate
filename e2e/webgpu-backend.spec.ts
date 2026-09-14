import { expect, test } from "@playwright/test";
import type { runWebGpuProof } from "../apps/editor/src/testing/webgpu-proof";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      // Dawn's Windows decoder needs the D3D11 device exposed by ANGLE.
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      // Linux canvas presentation must use Chromium's Vulkan SwiftShader path
      // as well as Dawn. Its GPU pixel tests use this combination so shared
      // images do not cross an incompatible GL compositor during readback.
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

test("WebGPU renders native and graph PBR and CEL using native shaders", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /WebGPU uncaptured error|shader.*error|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  await page.goto("/?webgpuProof");
  await page.waitForFunction(() => "__babylonslateWebGpuProof" in window);
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateWebGpuProof: typeof runWebGpuProof;
      }
    ).__babylonslateWebGpuProof(),
  );
  await testInfo.attach("webgpu-material-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.retainedEngines).toBe(0);
  expect(result.cancelledEngineReleased).toBe(true);
  expect(result.captures).toHaveLength(4);
  expect(result.previews).toHaveLength(4);
  for (const capture of result.captures) {
    expect(capture.shaderLanguage).toBe(capture.backend === "webgpu" ? 1 : 0);
    expect(capture.maxTextureSize).toBeGreaterThanOrEqual(64);
    for (const half of [0, 1]) {
      let green = 0;
      for (let y = 0; y < 64; y++)
        for (let x = half * 32; x < half * 32 + 32; x++) {
          const i = (y * 64 + x) * 4;
          if (
            capture.pixels[i + 1] > 30 &&
            capture.pixels[i + 1] > capture.pixels[i] * 1.5
          )
            green++;
        }
      expect(
        green,
        `${capture.backend}/${capture.mode}/${half}`,
      ).toBeGreaterThan(100);
    }
  }
  // Native readback follows each API's origin and swap-chain channel order.
  // Compare the same displayed pixels without hiding texture orientation errors.
  const rgbaTopLeft = (capture: (typeof result.captures)[number]) => {
    const pixels: number[] = [];
    expect(["rgba8unorm", "bgra8unorm"]).toContain(capture.pixelFormat);
    const channels =
      capture.pixelFormat === "bgra8unorm" ? [2, 1, 0, 3] : [0, 1, 2, 3];
    for (let y = 0; y < 64; y++) {
      const row = capture.pixelOrigin === "bottom-left" ? 63 - y : y;
      for (let x = 0; x < 64; x++)
        for (const channel of channels)
          pixels.push(capture.pixels[(row * 64 + x) * 4 + channel]);
    }
    return pixels;
  };
  for (const mode of ["pbr", "cel"]) {
    const reference = rgbaTopLeft(
      result.captures.find(
        (capture) => capture.backend === "webgl2" && capture.mode === mode,
      )!,
    );
    const actual = rgbaTopLeft(
      result.captures.find(
        (capture) => capture.backend === "webgpu" && capture.mode === mode,
      )!,
    );
    let maxDifference = 0;
    for (let i = 0; i < reference.length; i++)
      maxDifference = Math.max(
        maxDifference,
        Math.abs(reference[i] - actual[i]),
      );
    expect(maxDifference, `${mode} backend pixel parity`).toBeLessThanOrEqual(
      2,
    );
    // Both texture rows must remain distinct; a solid-color/missing texture
    // fallback could otherwise satisfy backend parity.
    const upperGreen = actual[(24 * 64 + 20) * 4 + 1];
    const lowerGreen = actual[(40 * 64 + 20) * 4 + 1];
    expect(
      Math.abs(upperGreen - lowerGreen),
      `${mode} texture rows`,
    ).toBeGreaterThan(40);
    const previewReference = result.previews.find(
      (capture) => capture.backend === "webgl2" && capture.mode === mode,
    )!.pixels;
    const previewActual = result.previews.find(
      (capture) => capture.backend === "webgpu" && capture.mode === mode,
    )!.pixels;
    let previewDifference = 0;
    for (let i = 0; i < previewReference.length; i++)
      previewDifference = Math.max(
        previewDifference,
        Math.abs(previewReference[i] - previewActual[i]),
      );
    expect(
      previewDifference,
      `${mode} actual preview canvas parity`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        previewActual[(24 * 64 + 32) * 4 + 1] -
          previewActual[(40 * 64 + 32) * 4 + 1],
      ),
      `${mode} preview texture rows`,
    ).toBeGreaterThan(40);
  }
});
