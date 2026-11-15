import { describe, expect, it } from "vitest";
import { AssetVersionCache, diffAssetVersions, type AssetDiff, type AssetVersionSource, type SceneDiff, type GraphDiff, type TextureDiff } from "./asset-diff";
import { AssetDiffClient, type AssetDiffWorkerHandle } from "./asset-diff-client";
import { createAssetDiffHandler, type AssetDiffReplyMessage, type AssetDiffRequestMessage } from "./asset-diff-protocol";
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
    // The script canvas draws each version as stored.
    expect(event.canvas).toBe("script");
    expect((event.base as { nodes: unknown[] }).nodes).toHaveLength(3);
    expect(view.memberGroups).toEqual([
      { id: "variables", title: "Variables", members: [{ id: "mult", name: "Sprint Multiplier", kind: "variable", status: "added", summary: "Float · 1.5" }] },
      { id: "functions", title: "Functions", members: [{ id: "sprint", name: "Sprint", kind: "function", status: "changed", summary: "1 Node Changed" }] },
    ]);
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

  it("compares a Material as stored: nodes titled and pins named by its catalog, wires by their ends, each version kept for its canvas", async () => {
    const node = (id: string, type: string, properties: Record<string, unknown> = {}, x = 0) => ({ id, type, position: { x, y: 0 }, properties });
    const wire = (id: string, from: string, fromPin: string, to: string, toPin: string) => ({ id, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin });
    const material = (nodes: unknown[], edges: unknown[], blendMode: string) => ({ name: "Water", domain: "surface", shadingModel: "pbr", blendMode, twoSided: false, nodes, edges });
    const base = await asset("Material", { document: material(
      [node("out", "output.surface", { "default:roughness": [0.5] }), node("wet", "param.float", { name: "Wetness", value: [1] }), node("mul", "math.multiply", { "default:b": [1] })],
      [wire("e1", "wet", "out", "mul", "a"), wire("e2", "mul", "out", "out", "roughness")],
      "opaque",
    ) });
    const compare = await asset("Material", { document: material(
      [node("out", "output.surface", { "default:roughness": [0.25] }), node("wet", "param.float", { name: "Wetness", value: [1] }, 40), node("tint", "const.float", { value: [2] })],
      [wire("e3", "tint", "out", "out", "roughness")],
      "translucent",
    ) });
    const view = (await diff(base, compare)).view as GraphDiff;
    expect(view.sections).toHaveLength(1);
    const graph = view.sections[0]!;
    expect([graph.id, graph.title, graph.canvas, graph.status]).toEqual(["graph", "Graph", "material", "changed"]);
    expect(graph.nodes.map((entry) => [entry.title, entry.status, entry.connections, entry.moved])).toEqual([
      ["Material Output", "changed", 2, false],
      ["Wetness", "changed", 1, true],
      ["Float", "added", 1, false],
      ["Multiply", "removed", 2, false],
    ]);
    expect(graph.nodes[0]!.pins).toEqual([{ id: "roughness", name: "Roughness", base: "0.5", compare: "0.25" }]);
    expect(graph.edgesAdded).toEqual(["e3"]);
    expect(graph.edgesRemoved).toEqual(["e1", "e2"]);
    expect((graph.compare as { blendMode: string }).blendMode).toBe("translucent");
    expect(view.groups[0]!.rows.find((row) => row.id === "blendMode")).toMatchObject({ base: "opaque", compare: "translucent", changed: true });
    expect(view.counts).toEqual({ added: 1, removed: 1, changed: 2 });
  });

  it("compares a Material Function's Inputs and Outputs as members", async () => {
    const fn = (defaultValue: number[], outputs: unknown[]) => ({ name: "Fresnel", description: "", inputs: [{ id: "power", name: "Power", type: "float", defaultValue }], outputs, nodes: [], edges: [] });
    const view = (await diff(
      await asset("MaterialFunction", { document: fn([5], []) }),
      await asset("MaterialFunction", { document: fn([3], [{ id: "result", name: "Result", type: "float" }]) }),
    )).view as GraphDiff;
    expect(view.memberGroups).toEqual([
      { id: "inputs", title: "Inputs", members: [{ id: "inputs:power", name: "Power", kind: "input", status: "changed", summary: "Float · 3" }] },
      { id: "outputs", title: "Outputs", members: [{ id: "outputs:result", name: "Result", kind: "output", status: "added", summary: "Float" }] },
    ]);
    expect(view.sections[0]).toMatchObject({ canvas: "material", status: "unchanged", base: null, compare: null });
  });

  it("compares a Particle Graph: Parameter nodes by their parameter's name, and its Parameters as members", async () => {
    const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const graph = (emitRate: number, speed: number, edges: unknown[]) => ({
      name: "Sparks",
      materialGuid: null,
      settings: { capacity: 256, loop: "infinite", duration: 1, prewarm: 0, blendMode: "additive", billboard: "camera" },
      parameters: [{ id: "speed", name: "Speed", type: "float", defaultValue: [speed] }],
      nodes: [node("out", "particle.output", { "default:emitRate": [emitRate] }), node("create", "particle.create"), node("p", "input.parameter", { parameterId: "speed" })],
      edges,
    });
    const view = (await diff(
      await asset("ParticleGraph", { document: graph(30, 1, []) }),
      await asset("ParticleGraph", { document: graph(60, 2, [{ id: "w", sourceNodeId: "p", sourcePinId: "out", targetNodeId: "create", targetPinId: "emitPower" }]) }),
    )).view as GraphDiff;
    const section = view.sections[0]!;
    expect(section.canvas).toBe("particle");
    expect(section.nodes.map((entry) => [entry.title, entry.status, entry.connections])).toEqual([
      ["Emitter Output", "changed", 0],
      ["Create Particle", "changed", 1],
      ["Speed", "changed", 1],
    ]);
    expect(section.nodes[0]!.pins).toEqual([{ id: "emitRate", name: "Emit Rate", base: "30", compare: "60" }]);
    expect(view.memberGroups).toEqual([{ id: "parameters", title: "Parameters", members: [{ id: "speed", name: "Speed", kind: "parameter", status: "changed", summary: "Float · 2" }] }]);
  });

  it("compares a Behaviour Tree: its nodes' settings, and parent-to-child links as wires", async () => {
    const node = (id: string, kind: string, classId: string, children: string[], properties: Record<string, unknown> = {}) => ({ id, kind, classId, children, decorators: [], services: [], properties });
    const tree = (durationMs: number, extra: boolean) => ({
      name: "Guard",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        node("root", "selector", "bt.composite.selector", ["seq"]),
        node("seq", "sequence", "bt.composite.sequence", extra ? ["wait", "fail"] : ["wait"]),
        node("wait", "task", "bt.task.wait", [], { durationMs }),
        ...(extra ? [node("fail", "task", "bt.task.fail", [])] : []),
      ],
      editorPositions: { root: { x: 0, y: 0 }, seq: { x: 0, y: 180 }, wait: { x: 0, y: 360 }, ...(extra ? { fail: { x: 248, y: 360 } } : {}) },
    });
    const view = (await diff(await asset("BehaviourTree", { document: tree(1000, false) }), await asset("BehaviourTree", { document: tree(2000, true) }))).view as GraphDiff;
    const section = view.sections[0]!;
    expect([section.canvas, section.status]).toEqual(["behaviour-tree", "changed"]);
    expect(section.nodes.map((entry) => [entry.title, entry.status, entry.connections])).toEqual([
      ["Sequence", "changed", 1],
      ["Wait", "changed", 0],
      ["Fail", "added", 1],
    ]);
    expect(section.nodes[1]!.fields).toEqual([{ id: "properties.durationMs", label: "Duration MS", base: "1000", compare: "2000", changed: true }]);
    expect(section.edgesAdded).toEqual(["bt-seq-fail"]);
    // The tree is not a graph by its fields: nothing else is listed.
    expect(view.groups.flatMap((group) => group.rows).filter((row) => row.changed)).toEqual([]);
  });

  it("compares an Animation Graph's State Machine, each state's and rule's graph, its Variables and the transitions' settings", async () => {
    const script = (value: number) => ({ nodes: [{ id: "play", type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "anim.pose.play", title: "Play Animation", "default:rate": value } }], edges: [] });
    const state = (id: string, name: string, x: number, rate = 1) => ({ id, name, position: { x, y: 0 }, stateGraph: script(rate) });
    const document = (rate: number, blendSeconds: number, run: boolean, speed: number) => ({
      name: "Locomotion",
      skeletonGuid: null,
      previewModelGuid: null,
      variables: [{ id: "v", name: "Speed", typeId: "float", defaultValue: speed }],
      stateMachine: {
        entryStateId: "idle",
        states: [state("idle", "Idle", 0, rate), state("walk", "Walk", 240), ...(run ? [state("run", "Run", 480)] : [])],
        transitions: [{ id: "t1", fromStateId: "idle", toStateId: "walk", blendSeconds, priority: 0, ruleGraph: { nodes: [], edges: [] } }],
        aliases: [],
      },
      animationObject: { nodes: [{ id: "event-update", type: "anim.event.update", position: { x: 80, y: 240 }, data: { title: "Event Update Animation" } }], edges: [] },
    });
    const view = (await diff(
      await asset("AnimationGraph3D", { document: document(1, 0.2, false, 0) }),
      await asset("AnimationGraph3D", { document: document(1.5, 0.3, true, 1) }),
    )).view as GraphDiff;
    expect(view.sections.map((section) => [section.id, section.title, section.canvas, section.status])).toEqual([
      ["machine", "State Machine", "state-machine", "changed"],
      ["state:idle", "Idle", "script", "changed"],
      ["state:walk", "Walk", "script", "unchanged"],
      ["state:run", "Run", "script", "added"],
      ["rule:t1", "Idle To Walk", "script", "unchanged"],
      ["object", "Animation Object", "script", "unchanged"],
    ]);
    expect(view.sections[0]!.nodes.map((entry) => [entry.title, entry.status])).toEqual([["Run", "added"]]);
    // The State Machine's canvas reads states and transitions without their graphs.
    expect((view.sections[0]!.compare as { stateMachine: { states: Record<string, unknown>[] } }).stateMachine.states.map((row) => "stateGraph" in row)).toEqual([false, false, false]);
    expect(view.sections[1]!.nodes[0]!.pins).toEqual([{ id: "rate", name: "Rate", base: "1", compare: "1.5" }]);
    expect(view.memberGroups).toEqual([{ id: "variables", title: "Variables", members: [{ id: "v", name: "Speed", kind: "variable", status: "changed", summary: "Float · 1" }] }]);
    const transition = view.groups.find((group) => group.id === "transition:t1")!;
    expect(transition.title).toBe("Idle To Walk");
    expect(transition.rows.filter((row) => row.changed)).toEqual([{ id: "blendSeconds", label: "Blend Seconds", base: "0.2", compare: "0.3", changed: true }]);
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

  it("keeps commit versions for the next diff within a byte budget, the least recently used going first, and never the working copy's", async () => {
    const document = scene([actor("a", "A")]);
    const stored = await asset("Scene", { document });
    // A kept version holds its .hasset and its parsed document, counted at the document chunk's length.
    const kept = stored.bytes.byteLength + encode(document).byteLength;
    // Room for two such versions, not three.
    const cache = new AssetVersionCache(2 * kept + kept / 2);
    const base = source(stored, "assets/Forest.scene.hasset@abc");
    const working = source(stored, null);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    expect([base.reads, working.reads]).toEqual([1, 2]);
    expect(cache.bytes).toBe(kept);
    const two = source(stored, "two");
    await diffAssetVersions("p", two, working, cache);
    // Over the budget: the least recently used (the first base) goes.
    await diffAssetVersions("p", source(stored, "three"), working, cache);
    expect(cache.bytes).toBe(2 * kept);
    await diffAssetVersions("p", two, working, cache);
    expect(two.reads).toBe(1);
    await diffAssetVersions("assets/Forest.scene.hasset", base, working, cache);
    expect(base.reads).toBe(2);

    // A version bigger than the whole budget serves its diff and is not kept.
    const small = new AssetVersionCache(kept - 1);
    const big = source(stored, "big");
    await diffAssetVersions("p", big, working, small);
    await diffAssetVersions("p", big, working, small);
    expect([big.reads, small.bytes]).toEqual([2, 0]);
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

  it("hands a Texture's raster to the main thread as it was read, keeping none of it in the cache", async () => {
    const raster = new Uint8Array(70 * 1024).fill(7);
    const texture = (width: number) => asset("Texture", { payload: { width, height: width }, chunks: [{ id: "source", kind: "source", mime: "image/png", data: raster }] });
    const base = source(await texture(1024), "t@base");
    const compare = source(await texture(2048), null);
    const cache = new AssetVersionCache();
    /** The diff on the worker side, each read answered with a buffer of its own, as the client sends them. */
    const run = () => new Promise<{ diff: AssetDiff; transfer: Transferable[]; sent: Uint8Array[] }>((resolve, reject) => {
      const sent: Uint8Array[] = [];
      const handle = createAssetDiffHandler((message, transfer = []) => {
        if (message.type === "read") {
          const side = message.side === "base" ? base : compare;
          void (message.blob ? side.readBlob(message.blob.sha256, message.blob.byteLength) : side.read()).then((bytes) => {
            const own = bytes ? bytes.slice() : null;
            if (own) sent.push(own);
            handle({ type: "read-result", id: message.id, read: message.read, bytes: own });
          });
        } else if (message.type === "result") resolve({ diff: message.diff, transfer, sent });
        else reject(new Error(message.message));
      }, cache);
      handle({ type: "diff", id: 1, path: "assets/Rock.texture.hasset", base: { key: base.key }, compare: { key: compare.key } });
    });
    const first = await run();
    const view = first.diff.view as TextureDiff;
    expect(view.base?.bytes).toEqual(raster);
    // The read itself moves on, no copy of it: the raster is one of the read's buffers, and transferred.
    expect(first.sent).toContain(view.base!.bytes);
    expect(first.transfer).toEqual([view.base!.bytes.buffer]);
    // The cached base keeps its .hasset, not the raster: the next diff reads the raster again, the .hasset not.
    await run();
    expect([base.reads, base.blobReads.length]).toEqual([1, 2]);
  });

  it("moves the working copy's reads to the worker without a copy, and copies a commit's, which its source may still hold", async () => {
    const stored = await asset("Scene", { document: scene([actor("a", "A")]) });
    const handed: Uint8Array[] = [];
    const fresh = (from: Recording): AssetVersionSource => ({
      ...from,
      owned: true,
      read: async () => {
        const bytes = (await from.read())!.slice();
        handed.push(bytes);
        return bytes;
      },
    });
    const commit = source(stored, "s@1");
    const posted: { message: AssetDiffRequestMessage; transfer: Transferable[] }[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<AssetDiffReplyMessage>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage(message: AssetDiffRequestMessage, transfer: Transferable[] = []) {
        posted.push({ message, transfer });
        handler(message);
      },
    };
    const handler = createAssetDiffHandler((reply) => queueMicrotask(() => worker.onmessage!({ data: reply } as MessageEvent<AssetDiffReplyMessage>)));
    const client = new AssetDiffClient({ createWorker: () => worker as unknown as AssetDiffWorkerHandle });
    await client.diff({ path: "p", base: commit, compare: fresh(source(stored, null)) });
    const reads = posted.flatMap(({ message, transfer }) => (message.type === "read-result" && message.bytes ? [{ bytes: message.bytes, transfer }] : []));
    expect(reads).toHaveLength(2);
    const working = reads.find((read) => read.bytes === handed[0]);
    expect(working?.transfer).toEqual([handed[0]!.buffer]);
    const base = reads.find((read) => read.bytes !== handed[0])!;
    expect(base.bytes).not.toBe(stored.bytes);
    expect(base.transfer).toEqual([base.bytes.buffer]);
    client.dispose();
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

  it("reads a cached version's blobs through the diff that needs them, after the diff that opened it failed", async () => {
    const client = new AssetDiffClient({ createWorker: () => null });
    const big = await asset("Scene", { document: scene(Array.from({ length: 2000 }, (_, index) => actor(`a${index}`, `A${index}`))) });
    const compare = await asset("Scene", { document: scene([actor("a", "A")]) });
    // The first diff reads the base's .hasset, then its blob read fails (a download that could not finish).
    await expect(client.diff({ path: "p", base: source({ ...big, blobs: new Map() }, "p@1"), compare: source(compare, null) })).rejects.toMatchObject({ code: "lfs-object-missing" });
    const again = source(big, "p@1");
    const result = await client.diff({ path: "p", base: again, compare: source(compare, null) });
    expect((result.view as SceneDiff).counts.removed).toBe(2000);
    expect(again.blobReads).toHaveLength(1);
    client.dispose();
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
