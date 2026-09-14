import { expect, test } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";

test("renders scene-isolated PBR and CEL environment response and raw graph sampling", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  const result = await page.evaluate(async () => {
    const host = window as unknown as {
      __babylonslateViewportTest: {
        environmentLightingProof(): Promise<{
          sharedUpload: boolean;
          distinctViews: boolean;
          hardware: unknown;
          failure?: string;
          captures: Record<string, { pixel: number[]; png: string }>;
        }>;
      };
    };
    return host.__babylonslateViewportTest.environmentLightingProof();
  });
  await testInfo.attach("environment-lighting", {
    body: JSON.stringify({ ...result, errors, consoleErrors }),
    contentType: "application/json",
  });
  for (const [name, capture] of Object.entries(result.captures))
    await testInfo.attach(name, {
      body: Buffer.from(capture.png.split(",")[1]!, "base64"),
      contentType: "image/png",
    });
  const pixel = (name: string) => result.captures[name]!.pixel.slice(0, 3);
  const close = (name: string, expected: number[], tolerance = 2) => {
    pixel(name).forEach((value, index) =>
      expect(Math.abs(value - expected[index]!), name).toBeLessThanOrEqual(
        tolerance,
      ),
    );
  };
  expect(errors).toEqual([]);
  expect(result.failure).toBeUndefined();
  expect(result.sharedUpload).toBe(true);
  expect(result.distinctViews).toBe(true);
  for (const material of ["native", "graph"]) {
    close(`${material}-pbr-0`, [0, 0, 0]);
    expect(pixel(`${material}-pbr-0.25`)[1]).toBeGreaterThan(20);
    expect(
      pixel(`${material}-pbr-0.5`)[1]! - pixel(`${material}-pbr-0.25`)[1]!,
    ).toBeGreaterThan(10);
    for (const strength of [0, 0.2])
      close(`${material}-cel-${strength}`, [0, 0, 0]);
    for (const strength of [0.3, 0.7])
      close(`${material}-cel-${strength}`, [0, 128, 0]);
    close(`${material}-cel-1`, [0, 255, 0]);
    close(`${material}-env-fallback`, pixel(`${material}-pbr-0.25`));
    expect(
      Math.max(
        ...pixel(`${material}-oriented-0`).map((value, index) =>
          Math.abs(value - pixel(`${material}-oriented-90`)[index]!),
        ),
      ),
      `${material} orientation changes actual irradiance`,
    ).toBeGreaterThan(20);
  }
  for (const intensity of [0.25, 0.5])
    close(`graph-pbr-${intensity}`, pixel(`native-pbr-${intensity}`));
  for (const rotation of [0, 90])
    close(`graph-oriented-${rotation}`, pixel(`native-oriented-${rotation}`));
  close("sibling-after-dispose", pixel("sibling-before-dispose"), 0);
  close("raw-disabled-green", [0, 255, 0]);
  close("raw-rotated-red", [255, 0, 0]);
  close("raw-zero-intensity-green", [0, 255, 0]);
  close("raw-rough-blue", [0, 0, 255]);
  close("raw-frozen-swap", [0, 89, 0]);
  close("raw-removed", [0, 0, 0]);
  close("raw-restored", pixel("raw-frozen-swap"), 0);
  expect(pixel("replacement-0")[1]).toBeGreaterThan(20);
  close("replacement-4", pixel("replacement-0"), 0);
  close("raw-post-process", [0, 26, 0]);
});
