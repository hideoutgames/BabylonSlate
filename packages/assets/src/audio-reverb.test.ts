import { describe, expect, it } from "vitest";
import {
  AUDIO_MAX_PROBES,
  AUDIO_OCCUPANCY_GRID_MAX_X,
  AUDIO_OCCUPANCY_GRID_MAX_Y,
  AUDIO_OCCUPANCY_GRID_MAX_Z,
  AUDIO_REVERB_CHUNK_MAX_BYTES,
} from "./audio-payload";
import {
  AUDIO_REVERB_CHUNK_ID,
  AUDIO_REVERB_VERSION,
  bakeAudioReverb,
  collectStaticAudioGeometry,
  decodeAudioReverbChunk,
  encodeAudioReverbChunk,
  extraChunksWithAudioReverb,
  geometryHashForAudioBake,
  interpolateAudioReverb,
  isDryAudioReverbFallback,
  occupancyGridForAudioBake,
  occlusionFactor,
} from "./audio-reverb";
import { createActor, createMeshComponent, identitySerializedTransform } from "@babylonslate/core";

function boxActor(
  id: string,
  position: [number, number, number],
  options?: { dynamic?: boolean; scale?: [number, number, number] },
) {
  const components = [createMeshComponent(`${id}-mesh`, "box")];
  if (options?.dynamic) {
    components.push({
      id: `${id}-body`,
      classId: "RigidBodyComponent",
      properties: { motionType: "dynamic", mass: 1 },
    });
  }
  return createActor(id, id, {
    transform: {
      ...identitySerializedTransform(),
      position,
      scale: options?.scale ?? [4, 4, 4],
    },
    components,
  });
}

describe("audio reverb chunk", () => {
  it("round-trips probes and marks a dry fallback", () => {
    const baked = {
      version: AUDIO_REVERB_VERSION,
      dryFallback: false,
      geometryHash: "abc",
      probes: [
        {
          x: 1,
          y: 2,
          z: 3,
          volume: 8,
          openness: 0.2,
          decay: 0.4,
          damping: 0.5,
          wet: 0.3,
        },
      ],
    };
    const bytes = encodeAudioReverbChunk(baked);
    expect(decodeAudioReverbChunk(bytes)).toEqual(baked);
    const dry = encodeAudioReverbChunk({
      version: AUDIO_REVERB_VERSION,
      dryFallback: true,
      geometryHash: "abc",
      probes: [],
    });
    const decoded = decodeAudioReverbChunk(dry);
    expect(decoded?.dryFallback).toBe(true);
    expect(isDryAudioReverbFallback(decoded)).toBe(true);
  });

  it("persists occupancy in v2 and treats a v1 chunk as unoccluded", () => {
    const bits = new Uint8Array(1);
    bits[0] = 0b0000_0110;
    const occupancy = {
      originX: 0,
      originY: 0,
      originZ: 0,
      voxelX: 2,
      voxelY: 2,
      voxelZ: 2,
      sizeX: 4,
      sizeY: 1,
      sizeZ: 1,
      bits,
    };
    const packed = encodeAudioReverbChunk({
      version: 2,
      dryFallback: false,
      geometryHash: "occ",
      probes: [],
      occupancy,
    });
    expect(packed.byteLength).toBeLessThanOrEqual(AUDIO_REVERB_CHUNK_MAX_BYTES);
    const decoded = decodeAudioReverbChunk(packed);
    expect(decoded?.occupancy).toEqual(occupancy);
    expect(
      occlusionFactor(
        { x: 1, y: 1, z: 1 },
        { x: 5, y: 1, z: 1 },
        decoded?.occupancy ?? null,
      ),
    ).toBe(1);
    expect(
      occlusionFactor(
        { x: 1, y: 1, z: 1 },
        { x: 3, y: 1, z: 1 },
        decoded?.occupancy ?? null,
      ),
    ).toBe(0.5);
    const legacy = encodeAudioReverbChunk({
      version: 1,
      dryFallback: false,
      geometryHash: "occ",
      probes: [],
    });
    expect(decodeAudioReverbChunk(legacy)?.occupancy).toBeUndefined();
    expect(
      occlusionFactor(
        { x: -1, y: 1, z: 1 },
        { x: 7, y: 1, z: 1 },
        decodeAudioReverbChunk(legacy)?.occupancy ?? null,
      ),
    ).toBe(0);
  });

  it("replaces the audioReverb extra chunk and keeps navmesh", () => {
    const bytes = encodeAudioReverbChunk({
      version: AUDIO_REVERB_VERSION,
      dryFallback: true,
      geometryHash: "h",
      probes: [],
    });
    const extra = extraChunksWithAudioReverb(
      [
        {
          id: "navmesh",
          kind: "navmesh",
          mime: "application/octet-stream",
          data: new Uint8Array([1]),
        },
      ],
      bytes,
    );
    expect(extra.some((chunk) => chunk.id === "navmesh")).toBe(true);
    expect(extra.filter((chunk) => chunk.id === AUDIO_REVERB_CHUNK_ID)).toHaveLength(
      1,
    );
  });
});

describe("audio reverb bake", () => {
  it("bakes identical static geometry to byte-identical chunks", async () => {
    const actors = [boxActor("wall", [0, 0, 0])];
    const a = await collectStaticAudioGeometry({ actors });
    const b = await collectStaticAudioGeometry({ actors });
    expect(geometryHashForAudioBake(a)).toBe(geometryHashForAudioBake(b));
    const first = bakeAudioReverb(a);
    const second = bakeAudioReverb(b);
    expect(first).toEqual(second);
    expect(first.byteLength).toBeLessThanOrEqual(AUDIO_REVERB_CHUNK_MAX_BYTES);
  });

  it("invalidates when static mesh actors move", async () => {
    const before = await collectStaticAudioGeometry({
      actors: [boxActor("wall", [0, 0, 0])],
    });
    const after = await collectStaticAudioGeometry({
      actors: [boxActor("wall", [10, 0, 0])],
    });
    expect(geometryHashForAudioBake(before)).not.toBe(
      geometryHashForAudioBake(after),
    );
  });

  it("ignores dynamic rigid bodies when hashing geometry", async () => {
    const staticOnly = await collectStaticAudioGeometry({
      actors: [boxActor("wall", [0, 0, 0])],
    });
    const withDynamic = await collectStaticAudioGeometry({
      actors: [
        boxActor("wall", [0, 0, 0]),
        boxActor("crate", [20, 0, 0], { dynamic: true }),
      ],
    });
    expect(geometryHashForAudioBake(staticOnly)).toBe(
      geometryHashForAudioBake(withDynamic),
    );
  });

  it("enforces occupancy, probe, and chunk budgets", async () => {
    const actors = [];
    for (let i = 0; i < 40; i += 1) {
      actors.push(boxActor(`w${i}`, [i * 6, 0, (i % 5) * 6]));
    }
    const geometry = await collectStaticAudioGeometry({ actors });
    const field = decodeAudioReverbChunk(bakeAudioReverb(geometry));
    expect(field).toBeTruthy();
    expect(field!.probes.length).toBeLessThanOrEqual(AUDIO_MAX_PROBES);
    const grid = occupancyGridForAudioBake(geometry);
    expect(grid.sizeX).toBeLessThanOrEqual(AUDIO_OCCUPANCY_GRID_MAX_X);
    expect(grid.sizeY).toBeLessThanOrEqual(AUDIO_OCCUPANCY_GRID_MAX_Y);
    expect(grid.sizeZ).toBeLessThanOrEqual(AUDIO_OCCUPANCY_GRID_MAX_Z);
    expect(field!.occupancy).toBeTruthy();
    expect(field!.occupancy!.bits.byteLength).toBeGreaterThan(0);
    expect(field!.occupancy!.sizeX).toBe(grid.sizeX);
    expect(field!.occupancy!.sizeY).toBe(grid.sizeY);
    expect(field!.occupancy!.sizeZ).toBe(grid.sizeZ);
  });

  it("yields every eight static mesh actors while collecting", async () => {
    const actors = Array.from({ length: 20 }, (_, i) =>
      boxActor(`w${i}`, [i * 3, 0, 0]),
    );
    let yields = 0;
    await collectStaticAudioGeometry({
      actors,
      yieldSlice: async () => {
        yields += 1;
      },
    });
    expect(yields).toBe(2);
  });

  it("writes a marked dry fallback when there is no static geometry", async () => {
    const geometry = await collectStaticAudioGeometry({
      actors: [boxActor("crate", [0, 0, 0], { dynamic: true })],
    });
    const bytes = bakeAudioReverb(geometry);
    const field = decodeAudioReverbChunk(bytes);
    expect(isDryAudioReverbFallback(field)).toBe(true);
  });

  it("interpolates at most two probes for the listener", () => {
    const wet = interpolateAudioReverb(
      { x: 0, y: 0, z: 0 },
      [
        { x: 0, y: 0, z: 0, volume: 1, openness: 0, decay: 0.5, damping: 0.5, wet: 0.4 },
        { x: 2, y: 0, z: 0, volume: 1, openness: 0, decay: 0.5, damping: 0.5, wet: 0.2 },
        { x: 40, y: 0, z: 0, volume: 1, openness: 1, decay: 0.1, damping: 0.1, wet: 0.9 },
      ],
    );
    expect(wet.wet).toBeGreaterThan(0.2);
    expect(wet.wet).toBeLessThanOrEqual(0.4);
    expect(wet.decay).toBe(0.5);
    expect(wet.damping).toBe(0.5);
  });

  it("blends decay and damping from the two nearest probes", () => {
    const profile = interpolateAudioReverb(
      { x: 1, y: 0, z: 0 },
      [
        { x: 0, y: 0, z: 0, volume: 1, openness: 0, decay: 0.2, damping: 0.2, wet: 0.1 },
        { x: 2, y: 0, z: 0, volume: 1, openness: 0, decay: 0.8, damping: 0.8, wet: 0.5 },
      ],
    );
    expect(profile.decay).toBeCloseTo(0.5, 5);
    expect(profile.damping).toBeCloseTo(0.5, 5);
    expect(profile.wet).toBeCloseTo(0.3, 5);
  });
});
