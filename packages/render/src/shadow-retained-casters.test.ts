import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { normalizeShadowSettings } from "@haptic/core";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { updateSceneRenderingSettings } from "./render-settings";
import { sceneShadowController } from "./shadow-controller";
import { markSmoothNormalShadowCaster } from "./shadow-bias";
import { RETAINED_CALL_DRAWS, RetainedShadowCasters, setRetainedShadowCasters, type RetainedCasterState } from "./shadow-retained-casters";
import { writeSceneShadowDebug } from "./shadow-debug";

type Upload = { buffer: "vertices" | "indices"; at: number; data: number[] };
type Call = { counts: number[]; offsets: number[]; slots: number[] };

/** Gives `engine` a WebGL2 context that records what the shared buffers are sent and what is drawn from them. */
function recordingContext(engine: NullEngine, options: { multiDraw?: boolean } = {}) {
  const uploads: Upload[] = [];
  const calls: Call[] = [];
  /** Instanced draws: the range drawn and the slots of its instances, read where the attribute pointed. */
  const instanced: { count: number; offset: number; slots: number[] }[] = [];
  let arrayUpload: number[] = [];
  let pointer = 0;
  const single: { count: number; offset: number; slot: number }[] = [];
  const constants = new Map<string, number>([["NO_ERROR", 0]]);
  let sentSlots: number[] = [];
  let sentDraw = -1;
  const extension = {
    multiDrawElementsWEBGL: (_mode: number, counts: Int32Array, _from: number, _type: number, offsets: Int32Array, _at: number, draws: number) => {
      // As the context does: a call cannot draw more than its lists hold.
      if (draws > counts.length || draws > offsets.length) throw new Error("INVALID_OPERATION: more draws than the lists hold");
      calls.push({ counts: Array.from(counts.subarray(0, draws)), offsets: Array.from(offsets.subarray(0, draws)), slots: sentSlots.slice(0, draws) });
    },
  };
  const constant = (key: string) => {
    if (!constants.has(key)) constants.set(key, 0x9000 + constants.size);
    return constants.get(key)!;
  };
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return constant(key);
      if (key === "getExtension") return (name: string) => name === "WEBGL_multi_draw" && options.multiDraw !== false ? extension : null;
      if (key === "bufferSubData")
        return (target: number, at: number, data: Float32Array | Uint32Array, from: number, length: number) => {
          const sent = Array.from(data.subarray(from, from + length));
          if (target !== constants.get("ELEMENT_ARRAY_BUFFER")) arrayUpload = sent;
          uploads.push({ buffer: target === constants.get("ELEMENT_ARRAY_BUFFER") ? "indices" : "vertices", at, data: sent });
        };
      if (key === "vertexAttribPointer") return (_location: number, _size: number, _type: number, _normalized: boolean, _stride: number, offset: number) => { pointer = offset; };
      if (key === "drawElementsInstanced")
        return (_mode: number, count: number, _type: number, offset: number, instances: number) => {
          instanced.push({ count, offset, slots: arrayUpload.slice(pointer / 4, pointer / 4 + instances) });
        };
      if (key === "drawElements") return (_mode: number, count: number, _type: number, offset: number) => { single.push({ count, offset, slot: sentDraw }); };
      if (key === "getError") return () => 0;
      if (key === "checkFramebufferStatus") return () => constant("FRAMEBUFFER_COMPLETE");
      return () => ({});
    },
  });
  Object.assign(engine, { _webGLVersion: 2, _gl: gl });
  vi.spyOn(engine, "setIntArray4").mockImplementation((_uniform, array) => { sentSlots = Array.from(array); return true; });
  vi.spyOn(engine, "setInt").mockImplementation((_uniform, value) => { sentDraw = value; return true; });
  const rows: { row: number; data: number[] }[] = [];
  vi.spyOn(engine, "updateTextureData").mockImplementation((_texture, data, _x, y) => { rows.push({ row: y, data: Array.from(data as Float32Array) }); });
  const states = vi.spyOn(engine, "setState");
  // NullEngine keeps no attribute state to record a vertex array against.
  const arrays = vi.spyOn(engine, "recordVertexArrayObject").mockImplementation(() => ({}) as WebGLVertexArrayObject);
  return { uploads, calls, single, instanced, rows, states, arrays };
}

/** `instanced`: layers draw the casters of one range in one call (the default in a Scene); off, as `shadowdebug instancing off`. */
function host(options: { multiDraw?: boolean; instanced?: boolean } = {}) {
  const engine = new NullEngine();
  const { uploads, calls, single, instanced, rows, states, arrays } = recordingContext(engine, options);
  const scene = new Scene(engine);
  if (!options.instanced) writeSceneShadowDebug(scene, "instancing", false);
  const camera = new FreeCamera("camera", new Vector3(0, 2, -10), scene);
  scene.activeCamera = camera;
  const sun = new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene);
  const generator = new ShadowGenerator(64, sun);
  const vouched = new Map<AbstractMesh, RetainedCasterState>();
  const retained = RetainedShadowCasters.create(scene, (mesh) => vouched.get(mesh))!;
  /** The scheduler vouches for `mesh`: its first walk, or a later one that found it changed. */
  const vouch = (mesh: AbstractMesh, safe = true) => {
    vouched.set(mesh, { revision: (vouched.get(mesh)?.revision ?? -1) + 1, safe });
    return mesh;
  };
  const box = (name: string, x = 0) => {
    const mesh = CreateBox(name, { size: 1 }, scene);
    mesh.position.x = x;
    mesh.computeWorldMatrix(true);
    return vouch(mesh) as Mesh;
  };
  /** One map pass: lists `meshes`, and draws what was taken. Returns which of them the shared buffer took. */
  const pass = (meshes: readonly AbstractMesh[], planes: readonly Plane[] | null = null, from = generator) => {
    const began = retained.begin(from, planes);
    const taken = meshes.map((mesh) => retained.take(mesh));
    retained.draw(from);
    return { began, taken };
  };
  /** The row of the data texture last uploaded for `slot`: its 20 floats. */
  const rowOf = (slot: number) => {
    const upload = rows.at(-1)!;
    return upload.data.slice(slot * 20, slot * 20 + 20);
  };
  return { engine, scene, camera, sun, generator, retained, vouch, vouched, box, pass, uploads, calls, single, instanced, rows, rowOf, states, arrays };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("RetainedShadowCasters", () => {
  it("is not built without a WebGL2 context", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    expect(RetainedShadowCasters.create(scene, () => undefined)).toBeNull();
    scene.dispose();
    engine.dispose();
  });

  it("draws the casters a layer lists in one call, from one buffer, each by its own slot", () => {
    const { engine, scene, retained, box, pass, uploads, calls, rowOf } = host();
    const a = box("a", 2), b = box("b", -3);
    const drawsBefore = engine._drawCalls.current, indicesBefore = scene.getActiveIndices();
    expect(pass([a, b])).toEqual({ began: true, taken: [true, true] });
    // Each geometry once: positions, normals, then its indices moved to where its vertices start.
    const vertices = uploads.filter((upload) => upload.buffer === "vertices"), indices = uploads.filter((upload) => upload.buffer === "indices");
    expect(vertices.map((upload) => [upload.at, upload.data.length])).toEqual([[0, 72], [0, 72], [24 * 12, 72], [24 * 12, 72]]);
    expect(vertices[0]!.data).toEqual(Array.from(a.getVerticesData("position")!));
    expect(vertices[1]!.data).toEqual(Array.from(a.getVerticesData("normal")!));
    expect(indices.map((upload) => upload.at)).toEqual([0, 36 * 4]);
    expect(indices[0]!.data).toEqual(Array.from(a.getIndices()!));
    expect(indices[1]!.data).toEqual(Array.from(b.getIndices()!).map((index) => index + 24));
    // One call draws both, each draw naming its slot, whose row holds its matrix.
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 36 * 4], slots: [0, 1] }]);
    expect(rowOf(0).slice(0, 16)).toEqual(Array.from(a.getWorldMatrix().m));
    expect(rowOf(1).slice(0, 16)).toEqual(Array.from(b.getWorldMatrix().m));
    // Has normals; evenly scaled.
    expect(rowOf(0).slice(16)).toEqual([1, 0, 0, 0]);
    // The call is counted as Babylon counts a draw: one draw call, and the indices drawn.
    expect(engine._drawCalls.current - drawsBefore).toBe(1);
    expect(scene.getActiveIndices() - indicesBefore).toBe(72);
    expect(retained.diagnostics()).toMatchObject({ casters: 2, draws: 2, vertices: 48, indices: 72, multiDraw: true, calls: 1, drawn: 2 });
  });

  it("draws the casters of one range of the buffer in one instanced call, each instance naming its row", () => {
    const { scene, retained, box, vouch, pass, instanced, calls, single } = host({ instanced: true });
    const mesh = box("mesh"), other = box("other", 3);
    const first = vouch(mesh.createInstance("first")), second = vouch(mesh.createInstance("second"));
    // In the order listed: the mesh and its instances draw one range, the other mesh its own between them.
    expect(pass([mesh, first, other, second]).taken).toEqual([true, true, true, true]);
    expect(instanced).toEqual([
      { count: 36, offset: 0, slots: [0, 1, 3] },
      { count: 36, offset: 36 * 4, slots: [2] },
    ]);
    expect(calls).toEqual([]);
    expect(single).toEqual([]);
    expect(retained.diagnostics()).toMatchObject({ casters: 4, instanced: true, calls: 2, drawn: 4 });
    // `shadowdebug instancing off`: every caster is a draw of its own again, in one call where the context can.
    instanced.length = 0;
    writeSceneShadowDebug(scene, "instancing", false);
    pass([mesh, first, other, second]);
    expect(instanced).toEqual([]);
    expect(calls).toEqual([{ counts: [36, 36, 36, 36], offsets: [0, 0, 36 * 4, 0], slots: [0, 1, 2, 3] }]);
    expect(retained.diagnostics()).toMatchObject({ instanced: false, calls: 3, drawn: 8 });
  });

  it("draws an instance from its source's geometry, at its own matrix", () => {
    const { vouch, box, pass, uploads, calls, rowOf } = host();
    const source = box("source");
    const copy = source.createInstance("copy");
    copy.position.set(4, 0, 1);
    copy.computeWorldMatrix(true);
    vouch(copy);
    expect(pass([source, copy]).taken).toEqual([true, true]);
    // One geometry in the buffers; two slots that draw the same indices.
    expect(uploads.filter((upload) => upload.buffer === "indices")).toHaveLength(1);
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 0], slots: [0, 1] }]);
    expect(rowOf(1).slice(12, 15)).toEqual([4, 0, 1]);
  });

  it("leaves to Babylon every caster whose draw is not its static geometry at one matrix", () => {
    const { engine, scene, vouch, vouched, box, pass, uploads, calls } = host();
    const unvouched = CreateBox("unvouched", { size: 1 }, scene);
    const unsafe = vouch(CreateBox("unsafe", { size: 1 }, scene), false);
    const thin = box("thin");
    // NullEngine reports no instancing, without which a mesh takes no thin instances.
    engine.getCaps().instancedArrays = true;
    thin.thinInstanceAdd(Matrix.Identity());
    expect(thin.hasThinInstances).toBe(true);
    const levels = box("levels");
    levels.addLODLevel(50, null);
    const updatable = vouch(CreateBox("updatable", { size: 1, updatable: true }, scene));
    const smooth = box("smooth");
    markSmoothNormalShadowCaster(smooth);
    const wire = box("wire");
    wire.material = new StandardMaterial("wire", scene);
    wire.material.fillMode = Material.WireFrameFillMode;
    const points = box("points");
    points.overrideRenderingFillMode = Material.PointFillMode;
    const empty = vouch(new Mesh("empty", scene));
    const meshes = [unvouched, unsafe, thin, levels, updatable, smooth, wire, points, empty];
    expect(pass(meshes).taken).toEqual(meshes.map(() => false));
    expect(vouched.size).toBe(8);
    expect(uploads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("lists nothing of a hidden caster, and keeps its place for when it shows", () => {
    const { retained, box, pass, uploads, calls } = host();
    const mesh = box("mesh"), other = box("other", 3);
    pass([mesh, other]);
    const sent = uploads.length;
    calls.length = 0;
    mesh.isVisible = false;
    // Babylon's list keeps it, and draws nothing of a hidden mesh.
    expect(pass([mesh, other]).taken).toEqual([false, true]);
    expect(calls).toEqual([{ counts: [36], offsets: [36 * 4], slots: [1] }]);
    mesh.isVisible = true;
    mesh.setEnabled(false);
    expect(pass([mesh, other]).taken).toEqual([false, true]);
    mesh.setEnabled(true);
    // A level of detail is blocked: its master draws it.
    const blocked = vi.spyOn(mesh, "isBlocked", "get").mockReturnValue(true);
    expect(pass([mesh, other]).taken).toEqual([false, true]);
    blocked.mockRestore();
    calls.length = 0;
    expect(pass([mesh, other]).taken).toEqual([true, true]);
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 36 * 4], slots: [0, 1] }]);
    // Nothing was sent again for it.
    expect(uploads).toHaveLength(sent);
    expect(retained.diagnostics()).toMatchObject({ casters: 2, vertices: 48 });
  });

  it("asks a caster once for the layers of a walked frame, and again in the next frame or outside one", () => {
    const { scene, retained, box, pass, sun } = host();
    const mesh = box("mesh"), hidden = box("hidden", 3);
    hidden.isVisible = false;
    const other = new ShadowGenerator(64, sun);
    const world = vi.spyOn(mesh, "getWorldMatrix"), enabled = vi.spyOn(hidden, "isEnabled");
    // Outside a walked frame every pass asks.
    pass([mesh, hidden]);
    pass([mesh, hidden], null, other);
    expect(world.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(enabled).toHaveBeenCalledTimes(2);
    world.mockClear(); enabled.mockClear();
    // The frame's first layer asks, its other layers list what it found.
    retained.beginFrame();
    expect(pass([mesh, hidden]).taken).toEqual([true, false]);
    const asked = world.mock.calls.length;
    expect(pass([mesh, hidden], null, other).taken).toEqual([true, false]);
    expect(world.mock.calls.length).toBe(asked);
    expect(enabled).toHaveBeenCalledTimes(1);
    // The frame ends with the Scene's render: a pass after it asks again and sees what changed since.
    scene.onAfterRenderObservable.notifyObservers(scene);
    hidden.isVisible = true;
    mesh.isVisible = false;
    expect(pass([mesh, hidden]).taken).toEqual([false, true]);
    // So does the next walked frame, and a frame the Scene has moved on from.
    retained.beginFrame();
    mesh.isVisible = true;
    expect(pass([mesh, hidden]).taken).toEqual([true, true]);
    retained.beginFrame();
    expect(pass([mesh, hidden]).taken).toEqual([true, true]);
    mesh.isVisible = false;
    (scene as unknown as { _frameId: number })._frameId += 1;
    expect(pass([mesh, hidden]).taken).toEqual([false, true]);
  });

  it("reads the world matrix the walk computed in a walked frame, and asks the mesh outside one", () => {
    const { retained, box, pass, vouched, rowOf } = host();
    const mesh = box("mesh", 2);
    const walked = mesh.getWorldMatrix();
    vouched.set(mesh, { ...vouched.get(mesh)!, world: walked });
    const asked = vi.spyOn(mesh, "getWorldMatrix");
    retained.beginFrame();
    expect(pass([mesh]).taken).toEqual([true]);
    expect(asked).not.toHaveBeenCalled();
    expect(rowOf(0).slice(12, 15)).toEqual([2, 0, 0]);
    // Without a walk's matrix, or outside a walked frame, the mesh is asked.
    vouched.set(mesh, { revision: vouched.get(mesh)!.revision, safe: true });
    retained.beginFrame();
    pass([mesh]);
    expect(asked).toHaveBeenCalled();
  });

  it("writes a caster's row again within a frame when a layer's floating origin differs", () => {
    const { scene, retained, box, pass, rows, sun } = host();
    const mesh = box("mesh");
    const other = new ShadowGenerator(64, sun);
    retained.beginFrame();
    pass([mesh]);
    const sent = rows.length;
    pass([mesh], null, other);
    expect(rows).toHaveLength(sent);
    vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(new Vector3(5, 0, 0));
    expect(pass([mesh], null, other).taken).toEqual([true]);
    expect(rows.length).toBeGreaterThan(sent);
  });

  it("draws each cull state in a call of its own, with the state Babylon's draw of the caster sets", () => {
    const { scene, generator, box, pass, calls, states } = host();
    const plain = box("plain");
    const mirrored = box("mirrored", 3);
    mirrored.scaling.x = -1;
    mirrored.computeWorldMatrix(true);
    const twoSided = box("two-sided", 6);
    twoSided.material = new StandardMaterial("two-sided", scene);
    twoSided.material.backFaceCulling = false;
    const front = box("front", 9);
    front.material = new StandardMaterial("front", scene);
    front.material.cullBackFaces = false;
    const turned = box("turned", 12);
    turned.material = new StandardMaterial("turned", scene);
    turned.material.sideOrientation = Material.ClockWiseSideOrientation;
    states.mockClear();
    pass([plain, mirrored, twoSided, front, turned]);
    // setState(culling, zOffset, force, reverseSide, cullBackFaces): a mirrored matrix turns the side, as a Material's own side does.
    expect(states.mock.calls).toEqual([
      [true, 0, false, false, false],
      [false, 0, false, false, true],
      [true, 0, false, false, true],
      [true, 0, false, true, true],
    ]);
    expect(calls.map((call) => call.slots)).toEqual([[3], [2], [0], [1, 4]]);
    // A right-handed Scene turns every side once more.
    scene.useRightHandedSystem = true;
    states.mockClear();
    pass([plain, mirrored]);
    expect(states.mock.calls).toEqual([[true, 0, false, false, true], [true, 0, false, true, true]]);
    expect(calls.slice(-2).map((call) => call.slots)).toEqual([[1], [0]]);
    scene.useRightHandedSystem = false;
    // A map of back faces only draws every caster so.
    generator.forceBackFacesOnly = true;
    states.mockClear();
    pass([plain, twoSided]);
    expect(states.mock.calls).toEqual([[true, 0, false, true, true], [true, 0, false, true, true]]);
  });

  it("leaves out the parts of a mesh that lie outside the map, and none of an instance's", () => {
    const { scene, vouch, pass, calls } = host();
    // Two boxes in one mesh, twenty units apart, each a part of its own.
    const one = CreateBox("one", { size: 1 }, scene);
    const positions = Array.from(one.getVerticesData("position")!), normals = Array.from(one.getVerticesData("normal")!), indices = Array.from(one.getIndices()!);
    one.dispose();
    const data = new VertexData();
    data.positions = [...positions, ...positions.map((value, index) => index % 3 === 0 ? value + 20 : value)];
    data.normals = [...normals, ...normals];
    data.indices = [...indices, ...indices.map((index) => index + 24)];
    const mesh = new Mesh("mesh", scene);
    data.applyToMesh(mesh);
    mesh.releaseSubMeshes();
    new SubMesh(0, 0, 24, 0, 36, mesh);
    new SubMesh(0, 24, 24, 36, 36, mesh);
    mesh.computeWorldMatrix(true);
    vouch(mesh);
    const copy = mesh.createInstance("copy");
    copy.computeWorldMatrix(true);
    vouch(copy);
    // The map ends at x = 10: the mesh's far part lies beyond it. An instance's parts carry its source's boxes, so
    // none of them is judged.
    const planes = [new Plane(-1, 0, 0, 10)];
    expect(pass([mesh, copy], planes).taken).toEqual([true, true]);
    expect(calls).toEqual([{ counts: [36, 36, 36], offsets: [0, 0, 36 * 4], slots: [0, 2, 3] }]);
    // Without planes every part is listed.
    calls.length = 0;
    pass([mesh]);
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 36 * 4], slots: [0, 1] }]);
  });

  it("writes a caster's row again only when its matrix or the floating origin moves", () => {
    const { scene, box, pass, rows, rowOf } = host();
    const mesh = box("mesh", 2), still = box("still", -2);
    pass([mesh, still]);
    expect(rows).toHaveLength(1);
    pass([mesh, still]);
    expect(rows).toHaveLength(1);
    mesh.position.x = 5;
    scene.incrementRenderId();
    pass([mesh, still]);
    expect(rows).toHaveLength(2);
    expect(rowOf(0).slice(12, 15)).toEqual([5, 0, 0]);
    expect(rowOf(1).slice(12, 15)).toEqual([-2, 0, 0]);
    // Babylon uploads a world matrix less the floating origin: so does every row, the still caster's too.
    vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(new Vector3(100, 20, -3));
    pass([mesh, still]);
    expect(rows).toHaveLength(3);
    expect(rowOf(0).slice(12, 15)).toEqual([-95, -20, 3]);
    expect(rowOf(1).slice(12, 15)).toEqual([-102, -20, 3]);
    pass([mesh, still]);
    expect(rows).toHaveLength(3);
  });

  it("takes a caster's normals as Babylon's draw of it does: an instance by its source's scaling unless one of them is mirrored", () => {
    const { scene, vouch, box, pass, rowOf } = host();
    const source = box("source");
    const stretched = source.createInstance("stretched");
    stretched.scaling.set(1, 3, 1);
    const mirrored = source.createInstance("mirrored");
    mirrored.scaling.set(-1, 3, 1);
    const own = box("own", 4);
    own.scaling.set(1, 3, 1);
    for (const mesh of [stretched, mirrored, own]) { mesh.computeWorldMatrix(true); vouch(mesh); }
    pass([source, stretched, mirrored, own]);
    expect([0, 1, 2, 3].map((slot) => rowOf(slot)[17])).toEqual([0, 0, 1, 1]);
    // The source's scaling decides for the instance drawn in its batch, and is followed when it changes.
    source.scaling.set(2, 1, 1);
    scene.incrementRenderId();
    source.computeWorldMatrix(true);
    pass([source, stretched, mirrored, own]);
    expect([0, 1, 2, 3].map((slot) => rowOf(slot)[17])).toEqual([1, 1, 1, 1]);
  });

  it("splits a long list into calls of the slots one uniform array holds", () => {
    const { vouch, box, pass, calls, retained } = host();
    const source = box("source");
    const meshes: AbstractMesh[] = [source];
    for (let index = 1; index < RETAINED_CALL_DRAWS + 40; index += 1) {
      const copy = source.createInstance(`copy ${index}`);
      copy.position.x = index;
      copy.computeWorldMatrix(true);
      meshes.push(vouch(copy));
    }
    pass(meshes);
    expect(calls.map((call) => call.counts.length)).toEqual([RETAINED_CALL_DRAWS, 40]);
    expect(calls[1]!.slots).toEqual(Array.from({ length: 40 }, (_, index) => RETAINED_CALL_DRAWS + index));
    expect(retained.diagnostics()).toMatchObject({ calls: 2, drawn: RETAINED_CALL_DRAWS + 40 });
  });

  it("draws one caster at a time from the same buffer where a layer cannot be drawn in one call", () => {
    const { engine, retained, box, pass, calls, single } = host({ multiDraw: false });
    const a = box("a"), b = box("b", 3);
    const before = engine._drawCalls.current;
    expect(pass([a, b]).taken).toEqual([true, true]);
    expect(calls).toEqual([]);
    expect(single).toEqual([{ count: 36, offset: 0, slot: 0 }, { count: 36, offset: 36 * 4, slot: 1 }]);
    expect(engine._drawCalls.current - before).toBe(2);
    expect(retained.diagnostics()).toMatchObject({ multiDraw: false, calls: 2, drawn: 2 });
  });

  it("deals a released caster's slot again, and packs the buffers once most of them is freed", () => {
    const { scene, retained, vouch, box, pass, uploads, calls } = host();
    const kept = box("kept");
    // A geometry large enough that freeing it is worth packing for.
    const large = new Mesh("large", scene);
    const positions = new Float32Array(30_000 * 3), normals = new Float32Array(30_000 * 3), indices = new Uint32Array(60_000);
    for (let index = 0; index < indices.length; index += 1) indices[index] = index % 30_000;
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.indices = indices;
    data.applyToMesh(large);
    vouch(large);
    const last = box("last", 5);
    pass([large, kept, last]);
    expect(retained.diagnostics()).toMatchObject({ casters: 3, vertices: 30_048, indices: 60_072 });
    retained.release(large);
    expect(retained.diagnostics()).toMatchObject({ casters: 2, vertices: 30_048 });
    uploads.length = 0;
    calls.length = 0;
    // The next geometry packs first: the two kept ranges move to the start, their indices and draws with them.
    const next = box("next", 8);
    pass([kept, last, next]);
    expect(retained.diagnostics()).toMatchObject({ casters: 3, draws: 3, vertices: 72, indices: 108 });
    const sentIndices = uploads.filter((upload) => upload.buffer === "indices");
    expect(sentIndices.map((upload) => upload.at)).toEqual([0, 36 * 4, 72 * 4]);
    expect(sentIndices[1]!.data).toEqual(Array.from(last.getIndices()!).map((index) => index + 24));
    // `next` has the slot `large` gave back.
    expect(calls).toEqual([{ counts: [36, 36, 36], offsets: [0, 36 * 4, 72 * 4], slots: [1, 2, 0] }]);
  });

  it("writes every range again into larger buffers when the casters outgrow them", () => {
    const { scene, retained, vouch, box, pass, uploads, arrays } = host();
    const first = box("first");
    pass([first]);
    expect(arrays).toHaveBeenCalledTimes(1);
    uploads.length = 0;
    // More vertices than the buffers first have room for.
    const large = new Mesh("large", scene);
    const data = new VertexData();
    data.positions = new Float32Array(5000 * 3);
    data.normals = new Float32Array(5000 * 3);
    data.indices = new Uint32Array([0, 1, 2]);
    data.applyToMesh(large);
    vouch(large);
    expect(pass([first, large]).taken).toEqual([true, true]);
    // The first range is written into the new buffers, then the new one after it.
    expect(uploads.map((upload) => [upload.buffer, upload.at, upload.data.length])).toEqual([
      ["vertices", 0, 72], ["vertices", 0, 72], ["indices", 0, 36],
      ["vertices", 24 * 12, 15_000], ["vertices", 24 * 12, 15_000], ["indices", 36 * 4, 3],
    ]);
    expect(uploads[5]!.data).toEqual([24, 25, 26]);
    // The program's vertex array is recorded again for the new buffers.
    expect(arrays).toHaveBeenCalledTimes(2);
    expect(retained.diagnostics()).toMatchObject({ casters: 2, vertices: 5024 });
  });

  it("leaves a caster to Babylon when the rendering budget has no room for its geometry or its row", () => {
    const tight = host();
    limitManagedRenderBytes(tight.engine, 1024);
    expect(tight.pass([tight.box("mesh")])).toEqual({ began: true, taken: [false] });
    expect(tight.calls).toEqual([]);
    expect(tight.retained.diagnostics()).toMatchObject({ casters: 0, vertices: 0 });
    // Room for the buffers (163 840 bytes at first), none for the data texture after them.
    const { engine, retained, box, pass, calls } = host();
    limitManagedRenderBytes(engine, 200_000);
    expect(pass([box("mesh")])).toEqual({ began: true, taken: [false] });
    expect(calls).toEqual([]);
    expect(retained.diagnostics()).toMatchObject({ casters: 0, draws: 0 });
  });

  it("leaves to Babylon a mesh whose parts are not whole triangles of its geometry", () => {
    const { scene, vouch, box, pass, calls } = host();
    const ragged = box("ragged");
    ragged.releaseSubMeshes();
    new SubMesh(0, 0, 24, 0, 34, ragged);
    vouch(ragged);
    const beyond = box("beyond");
    beyond.releaseSubMeshes();
    new SubMesh(0, 0, 24, 30, 12, beyond);
    vouch(beyond);
    // An index past the geometry's vertices would read another caster's.
    const stray = new Mesh("stray", scene);
    const data = new VertexData();
    data.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    data.indices = [0, 1, 3];
    data.applyToMesh(stray);
    vouch(stray);
    expect(pass([ragged, beyond, stray]).taken).toEqual([false, false, false]);
    expect(calls).toEqual([]);
  });

  it("keeps the rows written when the draws outgrow the data texture", () => {
    const { engine, vouch, box, pass, rows, calls } = host();
    const created = vi.spyOn(engine, "createRawTexture");
    const source = box("source", 7);
    const meshes: AbstractMesh[] = [source];
    const add = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        const copy = source.createInstance(`copy ${meshes.length}`);
        copy.position.x = meshes.length;
        copy.computeWorldMatrix(true);
        meshes.push(vouch(copy));
      }
    };
    // Four rows of 204 draws each hold these.
    add(799);
    pass(meshes);
    expect(created).toHaveBeenCalledTimes(1);
    rows.length = 0;
    calls.length = 0;
    add(100);
    pass(meshes);
    // The larger texture starts with every row written so far, the new draws that still fit the fourth row among them.
    expect(created).toHaveBeenCalledTimes(2);
    const data = created.mock.calls[1]![0] as Float32Array;
    expect(data.length).toBe(1020 * 8 * 4);
    expect(Array.from(data.subarray(12, 15))).toEqual([7, 0, 0]);
    expect(Array.from(data.subarray(799 * 20 + 12, 799 * 20 + 15))).toEqual([799, 0, 0]);
    expect(Array.from(data.subarray(810 * 20 + 12, 810 * 20 + 15))).toEqual([810, 0, 0]);
    // Then only the fifth row, which the rest of the new draws are on, is sent.
    expect(rows.map((upload) => [upload.row, upload.data.length])).toEqual([[4, 1020 * 4]]);
    expect(rows[0]!.data.slice(12, 15)).toEqual([816, 0, 0]);
    expect(calls.reduce((sum, call) => sum + call.counts.length, 0)).toBe(900);
  });

  it("frees the place of geometry its mesh replaced with data it cannot retain", () => {
    const { scene, retained, vouch, box, pass } = host();
    const large = new Mesh("large", scene);
    const indices = new Uint32Array(60_000);
    for (let index = 0; index < indices.length; index += 1) indices[index] = index % 30_000;
    const data = new VertexData();
    data.positions = new Float32Array(30_000 * 3);
    data.normals = new Float32Array(30_000 * 3);
    data.indices = indices;
    data.applyToMesh(large);
    vouch(large);
    expect(pass([large]).taken).toEqual([true]);
    // Positions that can change without notice: the mesh is Babylon's to draw from now on.
    large.setVerticesData("position", new Float32Array(30_000 * 3), true);
    vouch(large);
    expect(pass([large]).taken).toEqual([false]);
    expect(pass([box("next")]).taken).toEqual([true]);
    expect(retained.diagnostics()).toMatchObject({ casters: 1, vertices: 24, indices: 36 });
  });

  it("draws nothing a pass did not list", () => {
    const { scene, generator, retained, box, calls } = host();
    const mesh = box("mesh");
    // A readiness probe lists without drawing; the pass after it lists nothing.
    expect(retained.begin(generator, null)).toBe(true);
    expect(retained.take(mesh)).toBe(true);
    retained.discard(generator);
    retained.draw(generator);
    expect(calls).toEqual([]);
    // Nor does a pass that cannot list draw the list of the probe before it.
    retained.begin(generator, null);
    retained.take(mesh);
    scene.clipPlane = new Plane(0, 1, 0, 0);
    expect(retained.begin(generator, null)).toBe(false);
    retained.draw(generator);
    expect(calls).toEqual([]);
    scene.clipPlane = null;
    // A list is drawn once.
    retained.begin(generator, null);
    retained.take(mesh);
    retained.draw(generator);
    retained.draw(generator);
    expect(calls).toHaveLength(1);
  });

  it("does not list while the Scene clips, forces a fill mode or has the path turned off", () => {
    const { scene, box, pass } = host();
    const mesh = box("mesh");
    scene.clipPlane = new Plane(0, 1, 0, 0);
    expect(pass([mesh])).toEqual({ began: false, taken: [false] });
    scene.clipPlane = null;
    scene.forceWireframe = true;
    expect(pass([mesh]).began).toBe(false);
    scene.forceWireframe = false;
    scene.forcePointsCloud = true;
    expect(pass([mesh]).began).toBe(false);
    scene.forcePointsCloud = false;
    setRetainedShadowCasters(scene, false);
    expect(pass([mesh]).began).toBe(false);
    setRetainedShadowCasters(scene, true);
    expect(pass([mesh])).toEqual({ began: true, taken: [true] });
  });

  it("parks a caster the scheduler stops vouching for, and takes it back without sending its geometry again", () => {
    const { retained, vouch, box, pass, uploads, calls } = host();
    const mesh = box("mesh"), other = box("other", 3);
    pass([mesh, other]);
    const sent = uploads.length;
    vouch(mesh, false);
    expect(pass([mesh, other]).taken).toEqual([false, true]);
    expect(retained.diagnostics()).toMatchObject({ casters: 1, draws: 1, vertices: 48 });
    vouch(mesh, true);
    calls.length = 0;
    expect(pass([mesh, other]).taken).toEqual([true, true]);
    expect(uploads).toHaveLength(sent);
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 36 * 4], slots: [0, 1] }]);
  });

  it("parks a caster that gains levels of detail, though the scheduler saw no change", () => {
    const { box, pass } = host();
    const mesh = box("mesh");
    expect(pass([mesh]).taken).toEqual([true]);
    mesh.addLODLevel(40, null);
    expect(pass([mesh]).taken).toEqual([false]);
  });

  it("draws a mesh without normals as Babylon does: no normal moves its vertices", () => {
    const { scene, vouch, pass, uploads, rowOf } = host();
    const bare = new Mesh("bare", scene);
    const data = new VertexData();
    data.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    data.indices = [0, 1, 2];
    data.applyToMesh(bare);
    vouch(bare);
    expect(pass([bare]).taken).toEqual([true]);
    expect(uploads[1]).toEqual({ buffer: "vertices", at: 0, data: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(rowOf(0).slice(16)).toEqual([0, 0, 0, 0]);
  });

  it("gives replaced geometry a range of its own and frees the old one", () => {
    const { scene, retained, vouch, box, pass, uploads, calls } = host();
    const mesh = box("mesh");
    pass([mesh]);
    uploads.length = 0;
    calls.length = 0;
    const moved = Array.from(mesh.getVerticesData("position")!).map((value) => value * 2);
    mesh.setVerticesData("position", moved);
    vouch(mesh);
    expect(pass([mesh]).taken).toEqual([true]);
    expect(uploads[0]).toMatchObject({ buffer: "vertices", at: 24 * 12 });
    expect(uploads[0]!.data).toEqual(moved);
    expect(calls).toEqual([{ counts: [36], offsets: [36 * 4], slots: [0] }]);
    expect(retained.diagnostics()).toMatchObject({ casters: 1, draws: 1, vertices: 48 });
    // The old range is freed: once most of the buffers is, the next geometry packs them.
    const large = new Mesh("large", scene);
    const indices = new Uint32Array(60_000);
    for (let index = 0; index < indices.length; index += 1) indices[index] = index % 30_000;
    const data = new VertexData();
    data.positions = new Float32Array(30_000 * 3);
    data.normals = new Float32Array(30_000 * 3);
    data.indices = indices;
    data.applyToMesh(large);
    vouch(large);
    pass([mesh, large]);
    large.setIndices([0, 1, 2]);
    vouch(large);
    pass([mesh, large]);
    expect(retained.diagnostics()).toMatchObject({ vertices: 60_048, indices: 60_075 });
    pass([mesh, large, box("next")]);
    expect(retained.diagnostics()).toMatchObject({ casters: 3, vertices: 30_048, indices: 75 });
  });

  it("builds its buffers again after the context is restored, and draws no list made before", () => {
    const { engine, generator, retained, box, pass, uploads, calls, rows } = host();
    const a = box("a"), b = box("b", 3);
    pass([a, b]);
    retained.begin(generator, null);
    retained.take(a);
    uploads.length = 0;
    calls.length = 0;
    rows.length = 0;
    engine.onContextRestoredObservable.notifyObservers(engine);
    retained.draw(generator);
    expect(calls).toEqual([]);
    expect(retained.diagnostics()).toMatchObject({ casters: 0, vertices: 0 });
    expect(pass([b, a]).taken).toEqual([true, true]);
    expect(uploads.filter((upload) => upload.buffer === "indices").map((upload) => upload.at)).toEqual([0, 36 * 4]);
    expect(calls).toEqual([{ counts: [36, 36], offsets: [0, 36 * 4], slots: [0, 1] }]);
    expect(rows).toHaveLength(1);
  });

  it("returns what it reserved of the rendering budget when it is disposed", () => {
    const { engine, retained, box, pass } = host();
    const before = managedRenderReservations(engine).resourceBytes;
    pass([box("mesh")]);
    expect(managedRenderReservations(engine).resourceBytes).toBeGreaterThan(before);
    retained.dispose();
    expect(managedRenderReservations(engine).resourceBytes).toBe(before);
    expect(engine.onContextRestoredObservable.hasObservers()).toBe(false);
    expect(pass([box("late")])).toEqual({ began: false, taken: [false] });
  });
});

describe("a Scene's shadow maps", () => {
  it("leave a retained caster out of Babylon's list, draw it from the shared buffer, and forget it when it leaves", async () => {
    const engine = new NullEngine();
    Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16 });
    engine._features.supportCSM = true;
    engine._features.supportShadowSamplers = true;
    const { calls, instanced } = recordingContext(engine);
    const scene = new Scene(engine);
    const camera = new UniversalCamera("camera", new Vector3(0, 3, -12), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512, maxLocalLights: 1 }) });
    const added = new Promise<void>((resolve) => scene.onNewMeshAddedObservable.addOnce(() => resolve()));
    const material = new StandardMaterial("opaque", scene);
    const rigid = CreateBox("rigid", {}, scene);
    rigid.position.set(2, 1, 0);
    rigid.material = material;
    // A caster that draws through a hook can change without notice: Babylon keeps drawing it.
    const hooked = CreateBox("hooked", {}, scene);
    hooked.position.set(-2, 1, 0);
    hooked.material = material;
    hooked.onBeforeRenderObservable.add(() => {});
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
    const controller = sceneShadowController(scene);
    // A map's allocation is validated against the context's own framebuffers, which NullEngine has none of.
    const context = engine._gl;
    Object.assign(engine, { _gl: undefined });
    controller.register(sun, true);
    await added;
    controller.sync();
    Object.assign(engine, { _gl: context });
    controller.refreshShadowMaps();
    const map = controller.generator(sun)!.getShadowMap()!;
    const list = map.getCustomRenderList!(0, map.renderList!, map.renderList!.length)!;
    expect(list).toContain(hooked);
    expect(list).not.toContain(rigid);
    expect(controller.retainedCasters()).toMatchObject({ casters: 1, draws: 1, calls: 0 });
    // The pass draws what it listed after its clear, before Babylon's own casters.
    const drawPass = () => (map as unknown as { _objectRenderer: { onBeforeRenderingManagerRenderObservable: { notifyObservers(pass: number): void } } })
      ._objectRenderer.onBeforeRenderingManagerRenderObservable.notifyObservers(0);
    drawPass();
    // A Scene's layers draw instanced: one call for the one range listed.
    expect(instanced).toEqual([{ count: 36, offset: 0, slots: [0] }]);
    expect(calls).toEqual([]);
    // A pass that lists nothing (the sun has no such cascade) draws nothing of the list a probe left before it.
    map.getCustomRenderList!(0, map.renderList!, map.renderList!.length);
    expect(map.getCustomRenderList!(9, map.renderList!, map.renderList!.length)).toBeNull();
    drawPass();
    expect(instanced).toHaveLength(1);
    // A mesh that stops casting leaves the shared buffer, and returns to it when it casts again.
    controller.setParticipation(rigid, { castShadows: false });
    controller.sync();
    expect(controller.retainedCasters()).toMatchObject({ casters: 0, draws: 0 });
    controller.setParticipation(rigid, { castShadows: true });
    controller.sync();
    controller.refreshShadowMaps();
    expect(map.getCustomRenderList!(0, map.renderList!, map.renderList!.length)).not.toContain(rigid);
    expect(controller.retainedCasters()).toMatchObject({ casters: 1, draws: 1 });
    rigid.dispose();
    expect(controller.retainedCasters()).toMatchObject({ casters: 0, draws: 0 });
    scene.dispose();
  });
});
