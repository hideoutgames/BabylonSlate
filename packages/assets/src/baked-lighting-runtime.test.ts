import { expect, it, vi } from "vitest";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import {
  bakedLightingImportResult,
  encodeBakedLightingAsset,
} from "./baked-lighting";
import { loadRuntimeBake } from "./baked-lighting-runtime";

async function fixture(generated = false) {
  const { manifest, atlases } = await createBakedLightingFixture();
  if (generated) {
    manifest.dependencies.push("geometry");
    manifest.receivers[0]!.generatedGeometry = {
      assetGuid: "geometry",
      contentHash: "a".repeat(64),
    };
  }
  const bytes = await encodeBakedLightingAsset(
    await bakedLightingImportResult({
      guid: "bake",
      name: "Bake",
      manifest,
      atlases,
    }),
  );
  const payloads = new Map([["bake", bytes]]);
  const readAsset = vi.fn(async (guid: string) => {
    const bytes = payloads.get(guid);
    return bytes && { bytes };
  });
  return {
    payloads,
    manifest,
    options: {
      assetGuid: "bake",
      sceneGuid: "scene",
      inputs: manifest.inputs,
      readAsset,
    },
  };
}

it("reopens complete runtime payloads with physical E and receiver source membership without a baker", async () => {
  const { options } = await fixture();
  const loaded = await loadRuntimeBake(options);
  expect(loaded.validity.status).toBe("valid");
  if (!("lighting" in loaded)) throw new Error("Expected valid runtime bake");
  const bytes = loaded.lighting.atlases.get("atlas")!;
  expect(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true)).toBe(
    2,
  );
  expect(loaded.lighting.manifest.receivers[0]!.contributions).toEqual([
    { sourceId: "sun", term: "directAndIndirect" },
    { sourceId: "lamp", term: "indirectOnly" },
    { sourceId: "sky", term: "environmentDiffuse" },
  ]);
});

it("rejects stale inputs before reading generated geometry and refuses missing output dependencies", async () => {
  const { options } = await fixture(true);
  const stale = await loadRuntimeBake({
    ...options,
    inputs: { ...options.inputs, transforms: "f".repeat(64) },
  });
  expect(stale.validity).toEqual({
    status: "stale",
    reasons: ["transforms changed"],
  });
  expect(options.readAsset.mock.calls.map(([guid]) => guid)).toEqual(["bake"]);
  expect((await loadRuntimeBake(options)).validity).toMatchObject({
    status: "missing",
    reason: expect.stringMatching(/geometry is unavailable/),
  });
});

it("keeps unreadable or substituted containers out of usable runtime bindings", async () => {
  const { options, payloads } = await fixture();
  expect(
    (await loadRuntimeBake({ ...options, assetGuid: undefined })).validity
      .status,
  ).toBe("missing");
  expect(options.readAsset).not.toHaveBeenCalled();
  expect(
    (
      await loadRuntimeBake({
        ...options,
        readAsset: async () => {
          throw new Error("offline asset missing");
        },
      })
    ).validity,
  ).toEqual({ status: "missing", reason: "offline asset missing" });
  payloads.set("substituted", payloads.get("bake")!);
  expect(
    (await loadRuntimeBake({ ...options, assetGuid: "substituted" })).validity,
  ).toMatchObject({
    status: "missing",
    reason: expect.stringMatching(/identity differs/),
  });
});

it("does not publish decoded output after its owner cancels during asset IO", async () => {
  const { options } = await fixture();
  const abort = new AbortController();
  await expect(
    loadRuntimeBake({
      ...options,
      signal: abort.signal,
      readAsset: async (guid) => {
        const source = await options.readAsset(guid);
        abort.abort(new DOMException("Owner replaced", "AbortError"));
        return source;
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
