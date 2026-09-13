import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";

// Runtime primitives, with identical receiver/caster geometry for point/spot
// comparisons. This is a reproducible workload, not authored artwork.
function localLightRoom(kind: "point" | "spot", count: number) {
  const scene = { ...createDefaultScene(), name: `Rendering Baseline ${kind}` };
  scene.actors = scene.actors.filter(
    (actor) => actor.id === scene.settings.mainCameraActorId,
  );
  const box = (
    id: string,
    position: [number, number, number],
    scale: [number, number, number],
  ) =>
    createActor(id, id, {
      transform: { position, scale, rotation: [0, 0, 0, 1] },
      components: [createMeshComponent(`${id}-mesh`, "box")],
    });
  scene.actors.push(box("Floor", [0, -1.5, 0], [20, 0.5, 20]));
  scene.actors.push(box("Back Wall", [0, 2, 8], [20, 7, 0.5]));
  scene.actors.push(box("Side Wall", [-8, 2, 0], [0.5, 7, 16]));
  for (let i = 0; i < count; i += 1) {
    const x = (i % 4) * 3 - 4.5;
    const z = Math.floor(i / 4) * 3 - 4.5;
    scene.actors.push(box(`Caster ${i}`, [x, 0, z], [0.7, 2, 0.7]));
    scene.actors.push(
      createActor(`light-${i}`, `Light ${i}`, {
        transform: {
          position: [x, 3, z],
          scale: [1, 1, 1],
          rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        },
        components: [
          {
            id: `lamp-${i}`,
            classId: "LightComponent",
            properties: {
              lightKind: kind,
              color: [1, 1, 1],
              intensity: 2,
              range: 12,
              innerAngle: 45,
              outerAngle: 90,
              enabled: true,
              castShadows: true,
            },
          },
        ],
      }),
    );
  }
  scene.settings.shadowOverrides = {
    enabled: true,
    profile: "ultra",
    localLightMode: "manual",
    maxLocalLights: 16,
    localMapSize: 2048,
    mapSize: 4096,
    cascades: 4,
  };
  return scene;
}

async function baseline(page: Page) {
  return page.evaluate(() =>
    (
      globalThis as unknown as {
        __babylonslateViewportTest: {
          renderingBaseline(): {
            frameCount: number;
            engineScenes: number;
            render: {
              shadowPasses: number;
              shadowMapBytes: number;
              width: number;
              height: number;
            };
            [key: string]: unknown;
          };
        };
      }
    ).__babylonslateViewportTest.renderingBaseline(),
  );
}

type FrameSample = {
  atMs: number;
  intervalMs: number | null;
  frameDelta: number;
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: string;
  viewportFrameCap: number | null;
  documentVisible: boolean;
};
type ResourceSample = {
  atMs: number;
  estimatedTextureBytes: number;
  estimatedGeometryBytes: number;
  estimatedShadowBytes: number;
  engineTextures: number;
  engineRenderTargets: number;
  sceneMeshes: number;
  engineScenes: number;
  texturesAdded: number;
  texturesRemoved: number;
  targetsAdded: number;
  targetsRemoved: number;
};
type Measurement = {
  requestedMs: number;
  elapsedMs: number;
  cancelled: string | null;
  droppedSamples: number;
  frameSamples: FrameSample[];
  resourceSamples: ResourceSample[];
};

async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() =>
    (
      globalThis as unknown as {
        __babylonslateViewportTest: {
          measureRenderingBaseline(durationMs: number): Promise<Measurement>;
        };
      }
    ).__babylonslateViewportTest.measureRenderingBaseline(30_000),
  );
}

function distribution(values: number[]) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    samples: sorted.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    longestMs: sorted.at(-1) ?? null,
  };
}

function summarize(measurement: Measurement) {
  const frames = measurement.frameSamples;
  const resources = measurement.resourceSamples;
  const peak = (value: (sample: ResourceSample) => number) =>
    resources.length ? Math.max(...resources.map(value)) : null;
  const first = resources[0];
  const last = resources.at(-1);
  return {
    requestedMs: measurement.requestedMs,
    elapsedMs: measurement.elapsedMs,
    cancelled: measurement.cancelled,
    droppedSamples: measurement.droppedSamples,
    viewportFrameCaps: [
      ...new Set(frames.map((frame) => frame.viewportFrameCap)),
    ],
    hiddenFrameSamples: frames.filter((frame) => !frame.documentVisible).length,
    coalescedFrameSamples: frames.filter((frame) => frame.frameDelta !== 1)
      .length,
    presentedIntervals: {
      method:
        "Engine end-frame time when this viewport scheduler advances; presentation proxy, not hardware display timestamps",
      ...distribution(
        frames.flatMap((frame) =>
          frame.intervalMs === null ? [] : [frame.intervalMs],
        ),
      ),
    },
    viewportRenderCpu: distribution(frames.map((frame) => frame.cpuMs)),
    sharedEngineGpu: {
      method:
        "Shared Engine diagnostic readings; may repeat the last completed query and include sibling views; not viewport GPU timing",
      statuses: [...new Set(frames.map((frame) => frame.gpuStatus))],
      ...distribution(
        frames.flatMap((frame) =>
          frame.gpuStatus === "available" && frame.gpuMs !== null
            ? [frame.gpuMs]
            : [],
        ),
      ),
    },
    resources: {
      method:
        "Estimated cache textures plus viewport geometry/shadows; incomplete resource accounting, not measured GPU residency. Sampled every 250 ms plus boundaries; churn is an observed lower bound and misses objects created/released between samples.",
      samples: resources.length,
      peakEstimatedTextureBytes: peak((sample) => sample.estimatedTextureBytes),
      peakEstimatedGeometryBytes: peak(
        (sample) => sample.estimatedGeometryBytes,
      ),
      peakEstimatedShadowBytes: peak((sample) => sample.estimatedShadowBytes),
      peakEstimatedTrackedBytes: peak(
        (sample) =>
          sample.estimatedTextureBytes +
          sample.estimatedGeometryBytes +
          sample.estimatedShadowBytes,
      ),
      peakSharedEngineTextures: peak((sample) => sample.engineTextures),
      peakSharedEngineRenderTargets: peak(
        (sample) => sample.engineRenderTargets,
      ),
      peakViewportMeshes: peak((sample) => sample.sceneMeshes),
      first,
      last,
      sharedEngineChurn: last
        ? {
            texturesAdded: last.texturesAdded,
            texturesRemoved: last.texturesRemoved,
            targetsAdded: last.targetsAdded,
            targetsRemoved: last.targetsRemoved,
          }
        : null,
    },
  };
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const capture = await baseline(page).catch(() => null);
  if (capture) {
    await testInfo.attach("rendering-state-at-failure", {
      body: JSON.stringify(capture, null, 2),
      contentType: "application/json",
    });
  }
});

test("local renderer baseline bounds sixteen eligible point and spot shadow lights across reloads", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  const captures = [];
  for (const { id, kind } of [
    { id: "point", kind: "point" },
    { id: "spot", kind: "spot" },
    { id: "point-repeat", kind: "point" },
  ] as const) {
    await setPreviewScene(page, localLightRoom(kind, 16));
    await expect(page.getByTestId("viewport-panel")).toHaveAttribute(
      "data-scene-ready",
      "true",
    );
    const initial = await baseline(page);
    await expect
      .poll(async () => (await baseline(page)).frameCount)
      .toBeGreaterThan(initial.frameCount + 5);
    const measurement = await measure(page);
    const capture = await baseline(page);
    await testInfo.attach(`rendering-samples-${id}`, {
      body: JSON.stringify(measurement),
      contentType: "application/json",
    });
    expect(measurement.cancelled).toBeNull();
    expect(measurement.frameSamples.length).toBeGreaterThan(1);
    expect(measurement.resourceSamples.length).toBeGreaterThan(1);
    expect(capture.render.width).toBeGreaterThan(0);
    expect(capture.render.height).toBeGreaterThan(0);
    expect(capture.render.shadowPasses).toBeGreaterThan(0);
    // The former Ultra + 16 points could allocate gigabytes. This deliberately
    // loose safety invariant protects admission without duplicating its table.
    expect(capture.render.shadowMapBytes).toBeLessThan(512 * 1024 ** 2);
    expect(capture.render.shadowPasses).toBeLessThan(96);
    captures.push({
      fixture: id,
      lightKind: kind,
      eligibleLights: 16,
      measurement: summarize(measurement),
      ...capture,
    });
    await page
      .getByTestId("viewport-canvas")
      .screenshot({ path: testInfo.outputPath(`${id}.png`) });
  }
  expect(captures[2]!.engineScenes).toBe(captures[0]!.engineScenes);
  expect(errors).toEqual([]);
  await testInfo.attach("rendering-baseline", {
    body: JSON.stringify(
      {
        qualification:
        "Local browser observation with test instrumentation; not A16 qualification, thermal evidence, or Safari GPU residency. No 60 fps assertion.",
        browserProject: testInfo.project.name,
        browserVersion: page.context().browser()?.version() ?? null,
        viewportCss: page.viewportSize(),
        captures,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
