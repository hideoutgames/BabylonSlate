import { expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { bakeGeometryFixture } from "@babylonslate/test-kit/baked-geometry-fixtures";
import {
  AssetRegistry,
  fingerprintBakeGeometry,
  loadBakedLightingReference,
  loadBakedGeometryBindings,
  projectContentRoot,
} from "@babylonslate/assets";
import type { PreparedSceneBake } from "./scene-bake-preparation";
import { runSceneBakeJob, type SceneBakeJobAdapter } from "./scene-bake-job";

async function setup() {
  const storage = new MemoryStorageAdapter();
  await storage.pickProjectFolder("Bake Job");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  await registry.createAsset("project", "diffuse.babasset", {
    guid: "material",
    type: "Material",
    name: "Diffuse",
    version: 1,
    dependencies: [],
    payload: {},
    chunks: [],
  });
  const { source, topology } = bakeGeometryFixture();
  const geometry = await fingerprintBakeGeometry(source);
  const hash = "a".repeat(64);
  const inputs = {
    geometry,
    uv: hash,
    transforms: hash,
    materials: hash,
    lights: hash,
    environment: hash,
    settings: hash,
    provider: hash,
  };
  const prepared: PreparedSceneBake = {
    owner: { sceneGuid: "scene", generation: 7 },
    settings: { resolution: 32, paddingTexels: 2, samples: 1, bounces: 2 },
    inputs,
    dependencies: ["material"],
    meshes: [
      {
        identity: {
          actorId: "receiver",
          componentId: "mesh",
          primitive: { kind: "mesh" },
        },
        receiver: true,
        source,
        world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        transport: {
          positions: new Float32Array([
            0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1,
          ]),
          material: { kind: "diffuse", albedo: [0.1, 0.3, 0.7] },
        },
        hashes: { geometry, uv: hash, transforms: hash, materials: hash },
      },
    ],
    sources: [
      {
        id: "static",
        kind: "light",
        actorId: "static",
        componentId: "light",
        mobility: "static",
        inputHash: hash,
      },
      {
        id: "stationary",
        kind: "light",
        actorId: "stationary",
        componentId: "light",
        mobility: "stationary",
        inputHash: hash,
      },
    ],
    batches: [
      {
        mode: "full",
        sourceIds: ["static"],
        lights: [
          {
            kind: "point",
            position: [0, 2, 0],
            color: [1, 1, 1],
            intensity: 4,
          },
        ],
      },
      {
        mode: "indirect",
        sourceIds: ["stationary"],
        lights: [
          {
            kind: "point",
            position: [0, 2, 0],
            color: [1, 1, 1],
            intensity: 2,
          },
        ],
      },
    ],
  };
  const adapter: SceneBakeJobAdapter = {
    unwrap: vi.fn<SceneBakeJobAdapter["unwrap"]>(async (_source, options) => ({
      sourceHash: geometry,
      topology: structuredClone(topology),
      width: options.resolution,
      height: options.resolution,
      paddingTexels: options.paddingTexels,
      provider: { id: "xatlasjs", version: "0.2.0", adapterVersion: "1" },
    })),
    bake: vi.fn<SceneBakeJobAdapter["bake"]>(async (input, options) => {
      const irradiance = new Float32Array(input.size ** 2 * 4);
      const index = (16 * input.size + 16) * 4;
      irradiance.set(
        [
          input.mode === "full" ? 1 : 0.5,
          input.mode === "full" ? 1 : 0.5,
          input.mode === "full" ? 1 : 0.5,
          1,
        ],
        index,
      );
      options?.onDisposed?.({
        contextReleased: true,
        renderer: null,
        texturesBeforeDisposal: 0,
        geometriesBeforeDisposal: 0,
      });
      return {
        irradiance,
        size: input.size,
        samples: input.samples,
        coveredTexels: 1,
        estimatedWorkingBytes: 1024,
        elapsedMs: 1,
      };
    }),
  };
  let current = true;
  let reference = "prior-bake";
  const commit = vi.fn((guid: string) => {
    reference = guid;
    return true;
  });
  const options = {
    prepare: async () => prepared,
    isCurrent: () => current,
    registry,
    rootId: "project",
    name: "Scene Lighting",
    commit,
    adapter,
  };
  return {
    prepared,
    storage,
    registry,
    adapter,
    options,
    commit,
    stale: () => {
      current = false;
    },
    reference: () => reference,
  };
}

it("publishes complete mixed-source physical irradiance, padded UV bindings and immutable geometry for reopen", async () => {
  const fixture = await setup();
  const stages: string[] = [];
  const result = await runSceneBakeJob({
    ...fixture.options,
    onProgress: (value) => {
      stages.push(value.phase);
      if (value.progress < 100) expect(fixture.reference()).toBe("prior-bake");
    },
  });
  expect(fixture.reference()).toBe(result.guid);
  expect(fixture.commit).toHaveBeenCalledOnce();
  const reopened = new AssetRegistry(fixture.storage);
  await reopened.mountRoot(projectContentRoot());
  const loaded = await loadBakedLightingReference({
    registry: reopened,
    guid: result.guid,
    sceneGuid: "scene",
    inputs: fixture.prepared.inputs,
  });
  expect(loaded.validity.status).toBe("valid");
  const receiver = loaded.retained!.manifest.receivers[0];
  expect(receiver.contributions).toEqual([
    { sourceId: "static", term: "directAndIndirect" },
    { sourceId: "stationary", term: "indirectOnly" },
  ]);
  expect(receiver.scale).toEqual([28 / 32, 28 / 32]);
  expect(receiver.offset).toEqual([2 / 32, 2 / 32]);
  expect(
    (await loadBakedGeometryBindings(reopened, result.manifest)).size,
  ).toBe(1);
  const bytes = loaded.retained!.atlases.get(receiver.atlasGuid)!;
  const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const center = (16 * 32 + 16) * 16;
  expect(
    [0, 4, 8, 12].map((offset) => values.getFloat32(center + offset, true)),
  ).toEqual([1.5, 1.5, 1.5, 1]);
  expect(values.getFloat32(center - 16, true)).toBe(1.5);
  expect(values.getFloat32(center - 4, true)).toBe(0); // Padding has radiance but is not receiver coverage.
  expect(new Set(stages)).toEqual(
    new Set(["preparing", "unwrapping", "baking", "assembling", "writing"]),
  );
});

it.each(["cancel", "stale", "failure"] as const)(
  "retains the prior reference when %s interrupts a provider batch",
  async (kind) => {
    const fixture = await setup();
    const abort = new AbortController();
    const bake = fixture.adapter.bake;
    fixture.adapter.bake = async (input, options) => {
      const result = await bake(input, options);
      if (kind === "cancel") abort.abort();
      else if (kind === "stale") fixture.stale();
      else throw new Error("Transport failed");
      return result;
    };
    await expect(
      runSceneBakeJob({ ...fixture.options, signal: abort.signal }),
    ).rejects.toThrow();
    expect(fixture.reference()).toBe("prior-bake");
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.registry.list({ type: "BakedLighting" })).toHaveLength(0);
  },
);

it("refuses final publication after a source changes during immutable candidate writes", async () => {
  const fixture = await setup();
  const create = fixture.registry.createAsset.bind(fixture.registry);
  vi.spyOn(fixture.registry, "createAsset").mockImplementation(
    async (...args) => {
      const result = await create(...args);
      if (args[2].type === "BakedLighting") fixture.stale();
      return result;
    },
  );
  await expect(runSceneBakeJob(fixture.options)).rejects.toThrow(/changed/);
  expect(fixture.commit).not.toHaveBeenCalled();
  expect(fixture.reference()).toBe("prior-bake");
  expect(fixture.registry.list({ type: "BakedLighting" })).toHaveLength(1); // Refused immutable orphan, not the active reference.
});

it("serializes different owners through cleanup and rejects unsupported budgets before starting a Worker", async () => {
  const first = await setup();
  const second = await setup();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const preparing = runSceneBakeJob({
    ...first.options,
    prepare: async () => {
      await held;
      return first.prepared;
    },
  });
  await expect(runSceneBakeJob(second.options)).rejects.toThrow(
    /still running/,
  );
  finish();
  await preparing;
  second.prepared.meshes = Array.from(
    { length: 65 },
    () => second.prepared.meshes[0],
  );
  await expect(runSceneBakeJob(second.options)).rejects.toThrow(
    /working-data budget/,
  );
  expect(second.adapter.unwrap).not.toHaveBeenCalled();
});

it("reports the authoring deadline after provider cancellation cleanup and retains the previous bake", async () => {
  const fixture = await setup();
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.adapter.bake = (_input, options) =>
    new Promise((_resolve, reject) => {
      options!.signal!.addEventListener(
        "abort",
        () => {
          options!.onDisposed!({
            contextReleased: true,
            renderer: null,
            texturesBeforeDisposal: 0,
            geometriesBeforeDisposal: 0,
          });
          reject(new DOMException("Provider cancelled", "AbortError"));
        },
        { once: true },
      );
      started();
    });
  vi.useFakeTimers();
  try {
    const result = expect(runSceneBakeJob(fixture.options)).rejects.toThrow(
      "two-minute job limit",
    );
    await providerStarted;
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(fixture.reference()).toBe("prior-bake");
    expect(fixture.commit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("quarantines uncertain context disposal without publishing or admitting another context", async () => {
  const fixture = await setup();
  const bake = fixture.adapter.bake;
  fixture.adapter.bake = (input) => bake(input, { onDisposed: () => {} });
  await expect(runSceneBakeJob(fixture.options)).rejects.toThrow(
    /could not release/,
  );
  expect(fixture.reference()).toBe("prior-bake");
  expect(fixture.commit).not.toHaveBeenCalled();
  await expect(runSceneBakeJob(fixture.options)).rejects.toThrow(
    /previous bake could not release/,
  );
});
