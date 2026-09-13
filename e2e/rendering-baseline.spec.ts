import { expect, test, type Page } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent } from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";

// Runtime primitives, with identical receiver/caster geometry for point/spot
// comparisons. This is a reproducible workload, not authored artwork.
function localLightRoom(kind: "point" | "spot", count: number) {
  const scene = createDefaultScene(`Rendering Baseline ${kind}`);
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  const box = (id: string, position: [number, number, number], scale: [number, number, number]) =>
    createActor(id, id, { transform: { position, scale, rotation: [0, 0, 0, 1] },
      components: [createMeshComponent(`${id}-mesh`, "box")] });
  scene.actors.push(box("Floor", [0, -1.5, 0], [20, 0.5, 20]));
  scene.actors.push(box("Back Wall", [0, 2, 8], [20, 7, 0.5]));
  scene.actors.push(box("Side Wall", [-8, 2, 0], [0.5, 7, 16]));
  for (let i = 0; i < count; i += 1) {
    const x = (i % 4) * 3 - 4.5;
    const z = Math.floor(i / 4) * 3 - 4.5;
    scene.actors.push(box(`Caster ${i}`, [x, 0, z], [0.7, 2, 0.7]));
    scene.actors.push(createActor(`light-${i}`, `Light ${i}`, {
      transform: { position: [x, 3, z], scale: [1, 1, 1], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      components: [{ id: `lamp-${i}`, classId: "LightComponent", properties: {
        lightKind: kind, color: [1, 1, 1], intensity: 2, range: 12, angle: Math.PI / 2,
        enabled: true, castShadows: true,
      } }],
    }));
  }
  scene.settings.shadowOverrides = {
    enabled: true, profile: "ultra", localLightMode: "manual", maxLocalLights: 16,
    localMapSize: 2048, mapSize: 4096, cascades: 4,
  };
  return scene;
}

async function baseline(page: Page) {
  return page.evaluate(() => (globalThis as unknown as {
    __babylonslateViewportTest: { renderingBaseline(): {
      frameCount: number; engineScenes: number;
      render: { shadowPasses: number; shadowMapBytes: number; width: number; height: number };
      [key: string]: unknown;
    } };
  }).__babylonslateViewportTest.renderingBaseline());
}

test("local renderer baseline bounds sixteen eligible point and spot shadow lights across reloads", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  const captures = [];
  for (const kind of ["point", "spot", "point"] as const) {
    await setPreviewScene(page, localLightRoom(kind, 16));
    await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true");
    const initial = await baseline(page);
    await expect.poll(async () => (await baseline(page)).frameCount).toBeGreaterThan(initial.frameCount + 5);
    const capture = await baseline(page);
    expect(capture.render.width).toBeGreaterThan(0);
    expect(capture.render.height).toBeGreaterThan(0);
    expect(capture.render.shadowPasses).toBeGreaterThan(0);
    // The former Ultra + 16 points could allocate gigabytes. This deliberately
    // loose safety invariant protects admission without duplicating its table.
    expect(capture.render.shadowMapBytes).toBeLessThan(512 * 1024 ** 2);
    expect(capture.render.shadowPasses).toBeLessThan(96);
    captures.push({ lightKind: kind, eligibleLights: 16, ...capture });
    await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath(`${kind}-${captures.length}.png`) });
  }
  expect(captures[2]!.engineScenes).toBe(captures[0]!.engineScenes);
  expect(errors).toEqual([]);
  await testInfo.attach("rendering-baseline", {
    body: JSON.stringify({ qualification: "Local browser smoke; not A16 sustained performance or Safari residency", captures }, null, 2),
    contentType: "application/json",
  });
});
