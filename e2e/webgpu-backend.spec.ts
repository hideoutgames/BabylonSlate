import { expect, test } from "@playwright/test";
import type { runWebGpuProof } from "../apps/editor/src/testing/webgpu-proof";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
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
      /WebGPU uncaptured error|shader.*error|VALIDATE_STATUS|ERROR: 0:/i.test(
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
  expect(result.captures).toHaveLength(4);
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
});
