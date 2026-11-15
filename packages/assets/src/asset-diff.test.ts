import { describe, expect, it } from "vitest";
import { AssetVersionCache, diffAssetVersions, type AssetDiff, type AssetVersionSource, type SceneDiff, type GraphDiff, type TextureDiff } from "./asset-diff";
import { AssetDiffClient } from "./asset-diff-client";
import { encodeHasset, type ChunkInput } from "./hasset";
import { sha256Hex } from "./bytes";

// Hand-built containers on both sides of a diff, read through sources that record every read, so
// the tests can check what the diff decoded as well as what it reports.

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

interface Stored {
  bytes: Uint8Array;
  blobs: Map<string, Uint8Array>;
}

async function asset(type: string, options: { document?: unknown; payload?: Record<string, unknown>; chunks?: ChunkInput[]; blobThreshold?: number }): Promise<Stored> {
  const blobs = new Map<string, Uint8Array>();
  const chunks: ChunkInput[] = [
    ...(options.document === undefined ? [] : [{ id: "document", kind: "document", mime: "application/json", data: encode(options.document) }]),
    ...(options.chunks ?? []),
  ];
  const bytes = await encodeHasset({
    header: {
      dependencies: [],
      requiredDependencies: [],
      ...(type === "Class" ? { requiredVariableNames: [] } : {}),
      dependencyMetadataVersion: 1,
      engineVersion: "0.0.0",
      guid: `guid-${type}`,
      mode: "thin",
      name: type === "Texture" ? "Rock Albedo" : "Forest",
      payload: options.payload ?? {},
      type,
      version: 1,
    },
    chunks,
    blobThreshold: options.blobThreshold ?? 64 * 1024,
    writeBlob: async (sha, data) => {
      blobs.set(sha, data);
    },
  });
  return { bytes, blobs };
}

interface Recording extends AssetVersionSource {
  reads: number;
  blobReads: string[];
}

function source(stored: Stored | null, key: string | null): Recording {
  const recording: Recording = {
    key,
    reads: 0,
    blobReads: [],
    async read() {
      recording.reads += 1;
      return stored?.bytes ?? null;
    },
    async readBlob(sha) {
      recording.blobReads.push(sha);
      const blob = stored?.blobs.get(sha);
      if (!blob) throw Object.assign(new Error(`The server has no LFS object ${sha}.`), { code: "lfs-object-missing" });
      return blob;
    },
  };
  return recording;
}

const quat = (pitch: number) => [Math.sin((pitch * Math.PI) / 360), 0, 0, Math.cos((pitch * Math.PI) / 360)];
const transform = (pitch = 0) => ({ position: [0, 40, 0], rotation: quat(pitch), scale: [1, 1, 1] });

function actor(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, classId: "Actor", parentId: null, transform: transform(), visible: true, locked: false, components: [], folderId: null, ...extra };
}

function light(intensity: number, color: number[], pitch: number) {
  return actor("sun", "Directional Light", {
    folderId: "env",
    transform: transform(pitch),
    components: [{ id: "light", classId: "DirectionalLightComponent", properties: { intensity, color, castShadows: intensity > 3, mobility: "static" } }],
  });
}

const scene = (actors: unknown[], folders = [{ id: "env", name: "Environment", parentFolderId: null }, { id: "props", name: "Props", parentFolderId: null }]) =>
  ({ name: "Forest", viewportMode: "3d", settings: { fogEnabled: false }, actors, folders });

async function diff(base: Stored | null, compare: Stored | null, cache = new AssetVersionCache()): Promise<AssetDiff> {
  return diffAssetVersions("assets/Levels/Forest.scene.hasset", source(base, "assets/Levels/Forest.scene.hasset@base"), source(compare, null), cache);
}

describe("asset diffs", () => {
  it("compares Scenes by actor id: the tree of both versions, statuses and counts, and property groups only for actors that changed", async () => {
    const base = await asset("Scene", {
      document: scene([
        light(2, [1, 0.957, 0.878], -45),
        actor("sky", "Sky Atmosphere", { folderId: "env" }),
        actor("fence", "Fence 03", { folderId: "props" }),
        actor("rock", "Rock Cluster", { folderId: "props", properties: { seed: 1 } }),
        actor("start", "Player Start"),
      ]),
    });
    const compare = await asset("Scene", {
      document: scene([
        light(3.2, [1, 0.851, 0.659], -38),
        actor("sky", "Sky Atmosphere", { folderId: "env" }),
        actor("bridge", "Bridge", { folderId: "props" }),
        actor("rock", "Rock Cluster", { folderId: "props", properties: { seed: 2 } }),
        actor("start", "Player Start"),
      ]),
    });
    const result = await diff(base, compare);
    const view = result.view as SceneDiff;
    expect(result.status).toBe("changed");
    expect(view.counts).toEqual({ added: 1, removed: 1, changed: 2 });
    // Folders first, each actor under its folder, the removed one where the base had it.
    expect(view.rows.map((row) => [row.name, row.depth, row.status, row.changedBelow])).toEqual([
      ["Environment", 0, "unchanged", true],
      ["Directional Light", 1, "changed", false],
      ["Sky Atmosphere", 1, "unchanged", false],
      ["Props", 0, "unchanged", true],
      ["Bridge", 1, "added", false],
      ["Rock Cluster", 1, "changed", false],
      ["Fence 03", 1, "removed", false],
      ["Player Start", 0, "unchanged", false],
    ]);
    expect(Object.keys(view.actors).sort()).toEqual(["bridge", "fence", "rock", "sun"]);

    const groups = view.actors.sun!;
    const transformRows = groups.find((group) => group.id === "transform")!.rows;
    expect(transformRows.map((row) => [row.label, row.base, row.compare, row.changed])).toEqual([
      ["Location", "0, 40, 0", "0, 40, 0", false],
      ["Rotation", "−45°, 0°, 0°", "−38°, 0°, 0°", true],
      ["Scale", "1, 1, 1", "1, 1, 1", false],
    ]);
    const lightGroup = groups.find((group) => group.id === "component:light")!;
    expect(lightGroup.title).toBe("Directional Light");
    expect(lightGroup.status).toBe("changed");
    expect(lightGroup.rows.map((row) => [row.label, row.base, row.compare, row.changed])).toEqual([
      ["Intensity", "2", "3.2", true],
      ["Color", "#FFF4E0", "#FFD9A8", true],
      ["Cast Shadows", "Off", "On", true],
      ["Mobility", "static", "static", false],
    ]);
    expect(lightGroup.rows[1]).toMatchObject({ baseColor: "#FFF4E0", compareColor: "#FFD9A8" });
    // An added actor has nothing on the base side.
    expect(view.actors.bridge!.find((group) => group.id === "actor")!.rows[0]).toMatchObject({ label: "Name", base: null, compare: "Bridge", changed: true });
    expect(view.actors.fence!.every((group) => group.status === "removed")).toBe(true);
  });

  it("compares graphs by node id: changed pin values, added and removed nodes with their wires, variables and functions", async () => {
    const pins = (id: string, name: string) => ({ id, name, kind: "data", direction: "in", type: { kind: "float" } });
    const node = (id: string, type: string, title: string, data: Record<string, unknown> = {}) => ({ id, type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: type, title, ...data } });
    const graph = (speed: number, last: "print" | "sound", sprintNodes: unknown[], members: unknown[]) => ({
      nodes: [
        node("begin", "flow.event.beginPlay", "Begin Play"),
        node("speed", "call.setMaxWalkSpeed", "Set Max Walk Speed", { __pins: [pins("maxWalkSpeed", "Max Walk Speed")], "default:maxWalkSpeed": speed }),
        last === "print" ? node("print", "debug.print", "Print String", { message: "Hello" }) : node("sound", "audio.playSound2D", "Play Sound 2D"),
      ],
      edges: [
        { id: "e1", source: "begin", target: "speed", sourceHandle: "then", targetHandle: "exec" },
        { id: last === "print" ? "e2" : "e3", source: "speed", target: last, sourceHandle: "then", targetHandle: "exec" },
      ],
      members,
      functionGraphs: { sprint: { nodes: sprintNodes, edges: [] } },
    });
    const sprint = { id: "sprint", kind: "function", name: "Sprint" };
    const base = await asset("Class", { document: graph(600, "print", [node("a", "math.add", "Add", { "default:b": 1 })], [sprint]) });
    const compare = await asset("Class", {
      document: graph(750, "sound", [node("a", "math.add", "Add", { "default:b": 2 })], [sprint, { id: "mult", kind: "variable", name: "Sprint Multiplier", typeId: "float", defaultValue: 1.5 }]),
    });
    const view = (await diff(base, compare)).view as GraphDiff;
    const event = view.sections[0]!;
    expect(event.title).toBe("Event Graph");
    expect(event.nodes.map((entry) => [entry.title, entry.status, entry.connections])).toEqual([
      ["Set Max Walk Speed", "changed", 2],
      ["Play Sound 2D", "added", 1],
      ["Print String", "removed", 1],
    ]);
    expect(event.nodes[0]!.pins).toEqual([{ id: "maxWalkSpeed", name: "Max Walk Speed", base: "600", compare: "750" }]);
    expect(event.edgesAdded).toEqual(["e3"]);
    expect(event.edgesRemoved).toEqual(["e2"]);
    expect(event.base?.nodes).toHaveLength(3);
    expect(view.variables).toEqual([{ id: "mult", name: "Sprint Multiplier", kind: "variable", status: "added", summary: "Float · 1.5" }]);
    expect(view.functions).toEqual([{ id: "sprint", name: "Sprint", kind: "function", status: "changed", summary: "1 Node Changed" }]);
    expect(view.sections[1]).toMatchObject({ id: "sprint", title: "Sprint", status: "changed" });
    expect(view.counts).toEqual({ added: 2, removed: 1, changed: 3 });
  });

  it("does not count a remade wire or an unchanged graph as a change", async () => {
    const document = (edgeId: string) => ({
      nodes: [{ id: "a", type: "pinNode", position: { x: 0, y: 0 }, data: {} }, { id: "b", type: "pinNode", position: { x: 1, y: 0 }, data: {} }],
      edges: [{ id: edgeId, source: "a", target: "b", sourceHandle: "then", targetHandle: "exec" }],
    });
    const view = (await diff(await asset("Class", { document: document("x") }), await asset("Class", { document: document("y") }))).view as GraphDiff;
    expect(view.sections[0]).toMatchObject({ status: "unchanged", nodes: [], base: null, compare: null });
  });

  it("decodes a document both versions share once, and each side's own document when it changed", async () => {
    // Over the blob threshold, so the document lives in a blob on both sides, as a large Scene's does.
    const big = scene(Array.from({ length: 2000 }, (_, index) => actor(`a${index}`, `Actor ${index}`)));
    const same = await asset("Scene", { document: big });
    const base = source(same, "assets/Levels/Forest.scene.hasset@base");
    const compare = source(await asset("Scene", { document: big, payload: { thumbnail: "new" } }), null);
    const result = await diffAssetVersions("assets/Levels/Forest.scene.hasset", base, compare, new AssetVersionCache());
    expect(base.blobReads).toHaveLength(1);
    expect(compare.blobReads).toEqual([]);
    expect((result.view as SceneDiff).counts).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(result.header.find((row) => row.label === "Thumbnail")).toMatchObject({ base: null, compare: "new", changed: true });

    const edited = structuredClone(big);
    (edited.actors[5] as { name: string }).name = "Renamed";
    const changedSide = source(await asset("Scene", { document: edited }), null);
    const second = source(same, "assets/Levels/Forest.scene.hasset@other");
    const changed = await diffAssetVersions("assets/Levels/Forest.scene.hasset", second, changedSide, new AssetVersionCache());
    expect([second.blobReads.length, changedSide.blobReads.length]).toEqual([1, 1]);
    expect((changed.view as SceneDiff).counts).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it("keeps a commit's decoded version for the next diff, and never the working copy's", async () => {
    const stored = await asset("Scene", { document: scene([actor("a", "A")]) });
    const cache = new AssetVersionCache(2);
    const base = source(stored, "assets/Forest.scene.hasset@abc");
    const working = source(stored, null);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    expect([base.reads, working.reads]).toEqual([1, 2]);
    // The least recently used commit goes when the cache is full.
    for (const key of ["one", "two"]) await diffAssetVersions("p", source(stored, key), working, cache);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    expect(base.reads).toBe(2);
  });

  it("compares a Texture's facts and hands over both rasters, decoding a raster the versions share once", async () => {
    const raster = new Uint8Array(70 * 1024).fill(7);
    const chunk: ChunkInput = { id: "source", kind: "source", mime: "image/png", data: raster };
    const base = await asset("Texture", { payload: { width: 1024, height: 1024, usage: "albedo", compressionState: "compressed", compressionQuality: 2 }, chunks: [chunk] });
    const compare = await asset("Texture", { payload: { width: 2048, height: 2048, usage: "albedo", compressionState: "compressed", compressionQuality: 2 }, chunks: [chunk] });
    const baseSource = source(base, "t@base");
    const compareSource = source(compare, null);
    const result = await diffAssetVersions("assets/Rock.texture.hasset", baseSource, compareSource, new AssetVersionCache());
    const view = result.view as TextureDiff;
    const digest = (await sha256Hex(raster)).slice(0, 7);
    expect(view.rows.map((row) => [row.label, row.base, row.compare, row.changed])).toEqual([
      ["Size", "1024 × 1024", "2048 × 2048", true],
      ["File Size", expect.stringMatching(/KB$/), expect.stringMatching(/KB$/), false],
      ["Source", `PNG · 70 KB · ${digest}`, `PNG · 70 KB · ${digest}`, false],
      ["Usage", "albedo", "albedo", false],
      ["Compression", "Compressed · Quality 2", "Compressed · Quality 2", false],
      ["Downsample", "None", "None", false],
    ]);
    expect(view.base?.bytes).toEqual(raster);
    expect(view.compare).toBe(view.base);
    expect([baseSource.blobReads.length, compareSource.blobReads.length]).toEqual([1, 0]);
  });

  it("reports an asset the base lacks as added, and lists the other kinds' fields as groups", async () => {
    const compare = await asset("Enum", { document: { entries: [{ name: "Red" }], settings: { sorted: true } } });
    const result = await diff(null, compare);
    expect(result.status).toBe("added");
    expect(result.view).toEqual({
      kind: "properties",
      groups: [
        { id: "", title: "Enum", status: "changed", rows: [{ id: "entries", label: "Entries", base: null, compare: "1 Item", changed: true }] },
        { id: "settings", title: "Settings", status: "added", rows: [{ id: "settings.sorted", label: "Sorted", base: null, compare: "On", changed: true }] },
      ],
    });
    expect(result.chunks).toEqual([expect.objectContaining({ id: "document", status: "added", base: null })]);
  });

  it("rejects a version that is not an asset, and a blob neither copy nor server has", async () => {
    const garbage: Stored = { bytes: new TextEncoder().encode("teammate"), blobs: new Map() };
    await expect(diff(garbage, garbage)).rejects.toThrow(/\.hasset/);
    const big = await asset("Scene", { document: scene(Array.from({ length: 2000 }, (_, index) => actor(`a${index}`, `A${index}`))) });
    await expect(diff({ ...big, blobs: new Map() }, await asset("Scene", { document: scene([]) }))).rejects.toThrow(/no LFS object/);
  });

  it("runs diffs through the client, carrying a read's error code and stopping a cancelled diff", async () => {
    const client = new AssetDiffClient({ createWorker: () => null });
    const compare = await asset("Scene", { document: scene([actor("a", "A")]) });
    const result = await client.diff({ path: "assets/Forest.scene.hasset", base: source(null, "x@1"), compare: source(compare, null) });
    expect((result.view as SceneDiff).counts.added).toBe(1);

    const big = await asset("Scene", { document: scene(Array.from({ length: 2000 }, (_, index) => actor(`a${index}`, `A${index}`))) });
    await expect(client.diff({ path: "p", base: source({ ...big, blobs: new Map() }, "x@2"), compare: source(compare, null) })).rejects.toMatchObject({ code: "lfs-object-missing" });

    const controller = new AbortController();
    const never: AssetVersionSource = { key: null, read: () => new Promise(() => {}), readBlob: () => new Promise(() => {}) };
    const pending = client.diff({ path: "p", base: never, compare: never, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    client.dispose();
  });
});
