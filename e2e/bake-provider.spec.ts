import { expect, test, type Page } from "@playwright/test";
import type { BakePrototypeInput, BakePrototypeMesh } from "../packages/render/src/bake-prototype-input";

type MeshInput = Omit<BakePrototypeMesh, "positions" | "uv2"> & { positions: number[]; uv2?: number[] };
type Input = Omit<BakePrototypeInput, "meshes"> & { meshes: MeshInput[] };

function floor(): MeshInput {
  return {
    positions: [-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5],
    uv2: [0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0],
    material: { kind: "diffuse", albedo: [0.03, 0.6, 0.9], emission: [9, 3, 7] },
  };
}

function input(): Input {
  return { meshes: [floor()], lights: [{ kind: "point", position: [0, 2, 0], color: [1, 1, 1], intensity: 4 }],
    size: 4, samples: 8, bounces: 3, mode: "direct" };
}

async function openProvider(page: Page) {
  await page.goto("/?bake-provider-proof");
  await page.waitForFunction(() => "__bakePrototype" in globalThis);
}

async function bake(page: Page, job: Input, cancel: false | "sampling" | "compiling" = false) {
  return page.evaluate(async ({ job, cancel }) => {
    const provider = (globalThis as unknown as { __bakePrototype: typeof import("../packages/render/src/bake-provider-prototype") }).__bakePrototype;
    const controller = new AbortController();
    const progress: { phase: string; samples: number }[] = [];
    let disposal: { contextReleased: boolean; texturesBeforeDisposal: number; geometriesBeforeDisposal: number } | undefined;
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    try {
      const result = await provider.bakeLightingPrototype({ ...job, meshes: job.meshes.map((mesh) => ({
        ...mesh, positions: new Float32Array(mesh.positions), uv2: mesh.uv2 && new Float32Array(mesh.uv2),
      })) }, {
        signal: controller.signal,
        onProgress(value) {
          progress.push({ phase: value.phase, samples: value.samples });
          if ((cancel === "sampling" && value.samples >= 1) || (cancel === "compiling" && value.phase === "compiling")) controller.abort();
        },
        onDisposed(value) { disposal = value; },
      });
      return { result: { ...result, irradiance: [...result.irradiance] }, disposal, progress, heartbeats, error: null };
    } catch (error) {
      return { result: null, disposal, progress, heartbeats, error: { name: (error as Error).name, message: (error as Error).message } };
    } finally {
      clearInterval(timer);
    }
  }, { job, cancel });
}

function meanRGB(pixels: number[]) {
  const result = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) result[c] += pixels[i + c] / (pixels.length / 4);
  return result;
}

test("browser bake solves receiver irradiance, occlusion and separated colored bounce", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProvider(page);
  const point = await bake(page, input());
  expect(point.error).toBeNull();
  expect(point.disposal?.contextReleased).toBe(true);
  expect(point.result?.coveredTexels).toBe(16);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const px = (x + 0.5) / 4 - 0.5, pz = (y + 0.5) / 4 - 0.5;
    const expected = 8 / (4 + px * px + pz * pz) ** 1.5;
    for (let c = 0; c < 3; c++) expect(point.result!.irradiance[(y * 4 + x) * 4 + c]).toBeCloseTo(expected, 2);
  }
  // The receiver's strongly colored albedo and emission must not enter raw irradiance.
  const unlit = await bake(page, { ...input(), lights: [], mode: "full" });
  expect(unlit.error).toBeNull();
  expect(meanRGB(unlit.result!.irradiance)).toEqual([0, 0, 0]);

  const blocker: MeshInput = {
    positions: [-2, 1, -2, 2, 1, 2, -2, 1, 2, -2, 1, -2, 2, 1, -2, 2, 1, 2],
    material: { kind: "diffuse", albedo: [0, 0, 0] },
  };
  const occluded = await bake(page, { ...input(), meshes: [floor(), blocker] });
  expect(occluded.error).toBeNull();
  expect(meanRGB(occluded.result!.irradiance)).toEqual([0, 0, 0]);

  const receiver = floor();
  receiver.material = { kind: "diffuse", albedo: [0.5, 0.5, 0.5] };
  const wall: MeshInput = {
    positions: [1, 0, -3, 1, 0, 3, 1, 3, 3, 1, 0, -3, 1, 3, 3, 1, 3, -3],
    material: { kind: "diffuse", albedo: [0.8, 0.03, 0.03] },
  };
  const bounced = { ...input(), meshes: [receiver, wall], samples: 128, bounces: 4 };
  const full = await bake(page, { ...bounced, mode: "full" });
  const direct = await bake(page, { ...bounced, mode: "direct" });
  const indirect = await bake(page, { ...bounced, mode: "indirect" });
  for (const result of [full, direct, indirect]) {
    expect(result.error).toBeNull();
    expect(result.disposal?.contextReleased).toBe(true);
    expect(result.heartbeats).toBeGreaterThan(10);
  }
  const indirectMean = meanRGB(indirect.result!.irradiance);
  expect(indirectMean[0]).toBeGreaterThan(0.02);
  expect(indirectMean[0]).toBeGreaterThan(indirectMean[1] * 4);
  for (let i = 0; i < full.result!.irradiance.length; i++) {
    if (i % 4 !== 3) expect(full.result!.irradiance[i]).toBeCloseTo(direct.result!.irradiance[i] + indirect.result!.irradiance[i], 4);
  }

  const environment = await bake(page, { ...input(), meshes: [receiver], lights: [], environment: [0.2, 0.3, 0.4], samples: 128 });
  expect(environment.error).toBeNull();
  const environmentMean = meanRGB(environment.result!.irradiance);
  for (let c = 0; c < 3; c++) expect(Math.abs(environmentMean[c] / (Math.PI * [0.2, 0.3, 0.4][c]) - 1)).toBeLessThan(0.06);
  const blackReceiver = { ...receiver, material: { kind: "diffuse" as const, albedo: [0, 0, 0] as const } };
  const emitter = { ...wall, material: { kind: "diffuse" as const, albedo: [0, 0, 0] as const, emission: [0.8, 0.2, 0.1] as const } };
  const emissiveJob = { ...input(), lights: [], meshes: [blackReceiver, emitter], samples: 128 };
  const emissiveFull = await bake(page, { ...emissiveJob, mode: "full" });
  const emissiveDirect = await bake(page, emissiveJob);
  expect(emissiveFull.error).toBeNull();
  expect(emissiveDirect.error).toBeNull();
  expect(meanRGB(emissiveDirect.result!.irradiance)[0]).toBeGreaterThan(0.1);
  expect(emissiveFull.result!.irradiance).toEqual(emissiveDirect.result!.irradiance);
  expect(errors).toEqual([]);
  await testInfo.attach("bake-numerical-proof.json", { body: JSON.stringify({ point, unlit, occluded, full, direct, indirect, environment, emissiveFull, emissiveDirect }), contentType: "application/json" });
});

test("browser bake cancellation releases resources and admits the next job", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProvider(page);
  const compiling = await bake(page, input(), "compiling");
  expect(compiling.error?.name).toBe("AbortError");
  expect(compiling.disposal?.contextReleased).toBe(true);
  expect(compiling.progress.at(-1)?.phase).toBe("compiling");
  expect(compiling.progress.some((value) => value.phase === "sampling")).toBe(false);
  const cancelled = await bake(page, { ...input(), size: 64, samples: 512 }, "sampling");
  expect(cancelled.error?.name).toBe("AbortError");
  expect(cancelled.result).toBeNull();
  expect(cancelled.disposal?.contextReleased).toBe(true);
  expect(cancelled.disposal!.texturesBeforeDisposal).toBeGreaterThan(0);
  expect(cancelled.progress.at(-1)?.samples).toBeLessThan(512);
  const next = await bake(page, input());
  expect(next.error).toBeNull();
  expect(next.disposal?.contextReleased).toBe(true);
  expect(meanRGB(next.result!.irradiance)[0]).toBeGreaterThan(0.8);
  // Following jobs drain event-loop work; uncancelled upstream compile timers would
  // surface delayed disposed-program errors here, without an arbitrary timing sleep.
  expect(errors).toEqual([]);
  await testInfo.attach("bake-cancellation.json", { body: JSON.stringify({ compiling, cancelled, next }), contentType: "application/json" });
});
