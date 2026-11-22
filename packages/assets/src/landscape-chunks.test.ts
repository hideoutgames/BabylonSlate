import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  decodeLandscapeChunk,
  landscapeChunkId,
  parseLandscapeProperties,
  serializeLandscapeProperties,
} from "@haptic/core";
import {
  collectLandscapeChunksForPlay,
  extractLandscapeChunks,
  hydrateLandscapeChunksToEditor,
  LANDSCAPE_CHUNK_KIND,
  LANDSCAPE_CHUNK_MIME,
  unreadableComponentChunks,
} from "./landscape-chunks";

describe("landscape binary .hasset chunks", () => {
  it("extracts sculpted terrain into raw HPLD chunks and hydrates back to editor JSON", () => {
    const heights = new Float32Array(25);
    heights[12] = 6.25;
    const weights = new Uint8Array(25 * 4);
    for (let i = 0; i < 25; i++) weights[i * 4] = 255;
    weights[12 * 4] = 100;
    weights[12 * 4 + 1] = 155;

    const sculptedProps = serializeLandscapeProperties({
      width: 40,
      depth: 40,
      subdivisions: 4,
      heights,
      weights,
      materialGuid: "mat-terrain",
      collisionsEnabled: true,
    });
    const flatProps = serializeLandscapeProperties(parseLandscapeProperties({ subdivisions: 4 }));

    const scene = {
      ...createDefaultScene(),
      actors: [{
        ...createActor("Terrain", "Actor", {
          components: [
            { id: "comp-sculpted", classId: "LandscapeComponent", properties: { ...sculptedProps } },
            { id: "comp-flat", classId: "LandscapeComponent", properties: { ...flatProps } },
          ],
        }),
        id: "actor-terrain",
      }],
    };

    const extracted = extractLandscapeChunks(scene);
    expect(extracted.chunks).toHaveLength(1);
    const chunk = extracted.chunks[0]!;
    expect(chunk.id).toBe(landscapeChunkId("actor-terrain/comp-sculpted"));
    expect(chunk.kind).toBe(LANDSCAPE_CHUNK_KIND);
    expect(chunk.mime).toBe(LANDSCAPE_CHUNK_MIME);
    expect(chunk.data.byteLength).toBe(16 + 25 * 8);

    const diskSculpted = extracted.payload.actors[0]!.components[0]!.properties;
    expect(diskSculpted.chunkId).toBe(chunk.id);
    expect(diskSculpted.data).toBeUndefined();

    // Flat default terrain emits zero chunks and zero data.
    const diskFlat = extracted.payload.actors[0]!.components[1]!.properties;
    expect(diskFlat.chunkId).toBeUndefined();
    expect(diskFlat.data).toBeUndefined();

    // Hydrate back into Editor scene.
    const chunkMap = new Map([[chunk.id, chunk.data]]);
    const hydrated = hydrateLandscapeChunksToEditor(extracted.payload, chunkMap);
    const editorProps = hydrated.actors[0]!.components[0]!.properties;
    expect(editorProps.chunkId).toBeUndefined();
    expect(typeof editorProps.data).toBe("string");

    const parsed = parseLandscapeProperties(editorProps);
    expect(parsed.heights[12]).toBeCloseTo(6.25, 5);
    expect(parsed.weights[12 * 4]).toBe(100);
    expect(parsed.weights[12 * 4 + 1]).toBe(155);
  });

  it("collects raw binary chunks for Play from both unsaved Editor scenes and disk-externalized scenes", () => {
    const heights = new Float32Array(25);
    heights[6] = 4.5;
    const weights = new Uint8Array(25 * 4);
    for (let i = 0; i < 25; i++) weights[i * 4] = 255;

    const scene = {
      ...createDefaultScene(),
      actors: [{
        ...createActor("Hill", "Actor", {
          components: [
            {
              id: "comp-hill",
              classId: "LandscapeComponent",
              properties: {
                ...serializeLandscapeProperties({
                  width: 32,
                  depth: 32,
                  subdivisions: 4,
                  heights,
                  weights,
                  materialGuid: null,
                  collisionsEnabled: true,
                }),
              },
            },
          ],
        }),
        id: "actor-hill",
      }],
    };

    // Path 1: unsaved Editor scene with base64 `data` -> stripped to `chunkId` + raw Uint8Array.
    const fromEditor = collectLandscapeChunksForPlay(scene);
    const id = landscapeChunkId("actor-hill/comp-hill");
    expect(fromEditor.payload.actors[0]!.components[0]!.properties.data).toBeUndefined();
    expect(fromEditor.payload.actors[0]!.components[0]!.properties.chunkId).toBe(id);
    expect(decodeLandscapeChunk(fromEditor.chunks.get(id)!)?.heights[6]).toBeCloseTo(4.5, 5);

    // Path 2: disk scene already carrying `chunkId` + stored chunks -> reuses raw Uint8Array directly.
    const fromDisk = collectLandscapeChunksForPlay(fromEditor.payload, fromEditor.chunks);
    expect(fromDisk.chunks.get(id)).toBe(fromEditor.chunks.get(id));
  });

  it("never throws on damaged terrain, keeps it rather than saving flat terrain, and names it", () => {
    const meta = { width: 8, depth: 8, subdivisions: 4, materialGuid: null, collisionsEnabled: false };
    const scene = {
      ...createDefaultScene(),
      actors: [createActor("actor-ruin", "Ruin", {
        components: [
          { id: "bad-data", classId: "LandscapeComponent", properties: { ...meta, data: "%%%not base64%%%" } },
          { id: "bad-chunk", classId: "LandscapeComponent", properties: { ...meta, chunkId: landscapeChunkId("bad-chunk") } },
        ],
      })],
    };
    const damaged = new Map([[landscapeChunkId("bad-chunk"), new Uint8Array([1, 2, 3])]]);

    const extracted = extractLandscapeChunks(scene);
    expect(extracted.chunks).toEqual([]);
    expect(extracted.payload.actors[0]!.components[0]!.properties.data).toBe("%%%not base64%%%");

    const hydrated = hydrateLandscapeChunksToEditor(scene, damaged);
    expect(hydrated.actors[0]!.components[1]!.properties.chunkId).toBe(landscapeChunkId("bad-chunk"));
    expect(hydrated.actors[0]!.components[1]!.properties.data).toBeUndefined();
    expect(unreadableComponentChunks(hydrated)).toEqual([
      { actorName: "Ruin", componentId: "bad-data", kind: "Landscape" },
      { actorName: "Ruin", componentId: "bad-chunk", kind: "Landscape" },
    ]);

    // Play keeps a chunk id with no bytes for each, which the runtime reports and plays flat.
    const play = collectLandscapeChunksForPlay(scene, damaged);
    expect(play.chunks.size).toBe(0);
    expect(play.payload.actors[0]!.components.map((component) => component.properties.chunkId))
      .toEqual([landscapeChunkId("actor-ruin/bad-data"), landscapeChunkId("bad-chunk")]);
  });
});
