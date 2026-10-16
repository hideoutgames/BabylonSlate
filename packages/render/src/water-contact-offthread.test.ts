import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Matrix, MeshBuilder, NullEngine, Scene, type Mesh } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createWaterContactJobHandler, type WaterContactWorkerReply, type WaterContactWorkerRequest } from "./water-contact-jobs";
import { WATER_CONTACT_LAYER_OFFSETS, WATER_CONTACT_WORKER_TIMEOUT_MS, WaterContactField } from "./water-contact-field";
import type { WaterFieldSurface } from "./water-field";
import { createWaterMesh, updateSceneWater } from "./water-mesh";

/**
 * A worker thread stand-in that runs the real job handler. Requests and replies go through real structured cloning
 * with their transfer lists, so transferred arrays are detached on the posting side as in a browser; queued requests
 * run only when a test lets the worker run (`runWorkers`), as a thread would between frames.
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  /** `error` fails as a worker whose module or job threw; `silent` never replies (a hung worker). */
  static mode: "work" | "error" | "silent" = "work";
  onmessage: ((event: { data: WaterContactWorkerReply }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  /** Jobs posted to this worker. */
  jobs = 0;
  private readonly queue: WaterContactWorkerRequest[] = [];
  private readonly handle = createWaterContactJobHandler((reply, transfer) => {
    if (!this.terminated) this.onmessage?.({ data: structuredClone(reply, { transfer }) });
  });

  constructor(url: URL, options: { type: string }) {
    // The bundled entry must exist where the pool points, as a module worker.
    if (!existsSync(fileURLToPath(url)) || !url.pathname.endsWith("/water-contact.worker.ts") || options.type !== "module") throw new Error(`no worker at ${url.href}`);
    FakeWorker.all.push(this);
  }

  postMessage(message: WaterContactWorkerRequest, transfer: Transferable[] = []): void {
    this.queue.push(structuredClone(message, { transfer }));
    if (message.type === "job") this.jobs++;
  }

  terminate(): void { this.terminated = true; }

  run(): void {
    for (const request of this.queue.splice(0)) {
      if (this.terminated) return;
      if (FakeWorker.mode === "error") this.onerror?.({ message: "worker module failed", preventDefault() {} });
      else if (FakeWorker.mode === "work") this.handle(request);
    }
  }
}
const runWorkers = () => { for (const worker of FakeWorker.all) worker.run(); };

type ContactView = { data: Uint8Array | null; width: number; height: number; bounds: number[]; range: number; amplitude: number };
const view = (field: WaterContactField) => field as unknown as ContactView;
const contactsOf = (mesh: Mesh) => (mesh.material as unknown as { pluginManager: { _plugins: Array<{ contacts?: WaterContactField | null }> } })
  .pluginManager._plugins.find((plugin) => plugin.contacts)!.contacts!;

/** Signed metres at a world X/Z and rendered wave height (relative to rest), as the shader blends the layers. */
function contactAt(field: WaterContactField, x: number, z: number, height: number): number {
  const f = view(field);
  const u = Math.floor((x - f.bounds[0]!) * f.bounds[2]! * f.width), v = Math.floor((z - f.bounds[1]!) * f.bounds[3]! * f.height);
  const values = !f.data || u < 0 || v < 0 || u >= f.width || v >= f.height
    ? WATER_CONTACT_LAYER_OFFSETS.map(() => f.range)
    : WATER_CONTACT_LAYER_OFFSETS.map((_, k) => (f.data![(v * f.width + u) * 4 + k]! / 255 * 2 - 1) * f.range);
  const layer = (Math.max(-1, Math.min(1, height / f.amplitude)) * 0.5 + 0.5) * (values.length - 1);
  return values.reduce((sum, value, k) => sum + value * Math.max(0, 1 - Math.abs(k - layer)), 0);
}

/** Bytes that differ (every byte when the sizes differ). */
const differing = (a: Uint8Array | null, b: Uint8Array | null) =>
  !a || !b || a.length !== b.length ? Infinity : a.reduce((count, value, i) => count + (value === b[i] ? 0 : 1), 0);

function surfaceOf(scene: Scene, amplitude: number, slope = 0): WaterFieldSurface {
  const mesh = MeshBuilder.CreateGround("water", { width: 40, height: 40 }, scene);
  mesh.metadata = { slateWater: true };
  const restY = (_x: number, z: number) => z * slope;
  return { mesh, unbounded: false, amplitude, contactRange: 2, surfaceY: restY, restVaries: slope !== 0, restY };
}

describe("Water contact field off the main thread", () => {
  let engine: NullEngine, scene: Scene;
  const fields: WaterContactField[] = [];
  const setup = () => { engine = new NullEngine(); scene = new Scene(engine); };
  const field = (surface: WaterFieldSurface) => { const created = new WaterContactField(scene, surface); fields.push(created); return created; };
  // Transforms settle when a frame renders; a new render id lets moved meshes recompute.
  const frame = () => scene.incrementRenderId();
  afterEach(() => {
    for (const created of fields.splice(0)) created.dispose();
    scene?.dispose(); engine?.dispose();
    FakeWorker.all = []; FakeWorker.mode = "work";
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it("fills the same distances as the main thread, in full, for a moved object and for one that leaves", () => {
    setup();
    // A frame's rebuilds share a time budget: a still clock keeps both surfaces' rebuilds inside it.
    vi.spyOn(performance, "now").mockReturnValue(0);
    // A cone (a different cross-section per layer), a raft thinner than the layer spacing (cut at its mid-height) and
    // thin-instanced posts (closed interiors), on a sloped body so each is cut at the rest height beneath it.
    MeshBuilder.CreateCylinder("cone", { height: 4, diameterBottom: 4, diameterTop: 0, tessellation: 48 }, scene).position.set(-6, 0, 0);
    const raft = MeshBuilder.CreateBox("raft", { width: 1.4, height: 0.3, depth: 1 }, scene);
    raft.position.set(0, -0.075, 0);
    const posts = MeshBuilder.CreateBox("posts", { width: 1, height: 4, depth: 1 }, scene);
    const matrices = new Float32Array(32);
    Matrix.Translation(5, 0, -3).copyToArray(matrices, 0);
    Matrix.Translation(5, 0, 3).copyToArray(matrices, 16);
    posts.thinInstanceSetBuffer("matrix", matrices, 16, true);
    posts.thinInstanceRefreshBoundingInfo(true);
    frame();
    // Without workers (as here in Node) a surface rebuilds on the main thread for good.
    const here = field(surfaceOf(scene, 0.7, 0.05));
    expect(here.update(0)).toBe(true);
    expect(contactAt(here, 5, 3, 0)).toBeLessThan(-0.4);
    vi.stubGlobal("Worker", FakeWorker);
    const there = field(surfaceOf(scene, 0.7, 0.05));
    // Posted: nothing to draw until the reply lands.
    expect(there.update(0)).toBe(false);
    expect(there.texture).toBeNull();
    runWorkers();
    expect(there.update(16)).toBe(true);
    expect(there.texture).not.toBeNull();
    expect([view(there).width, view(there).height, ...view(there).bounds]).toEqual([view(here).width, view(here).height, ...view(here).bounds]);
    expect(differing(view(there).data, view(here).data)).toBe(0);
    // A moved raft rebuilds its neighbourhood: the worker now holds the other pieces and receives only the raft.
    const before = view(there).data!.slice();
    raft.position.x = 0.6; frame();
    here.update(200);
    expect(there.update(200)).toBe(false);
    runWorkers();
    expect(there.update(216)).toBe(true);
    expect(differing(view(there).data, before)).toBeGreaterThan(0);
    expect(differing(view(there).data, view(here).data)).toBe(0);
    // A raft lifted out of the water leaves the worker's pieces too: no waterline stays behind.
    raft.position.y = 20; frame();
    here.update(400); there.update(400); runWorkers(); there.update(416);
    expect(contactAt(there, 1.32, 0, 0)).toBeGreaterThan(1.9);
    expect(differing(view(there).data, view(here).data)).toBe(0);
  });

  it("draws the last landed contacts while one rebuild is in flight, and folds the moves meanwhile into the next", () => {
    setup();
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("Worker", FakeWorker);
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 4, depth: 1 }, scene);
    frame();
    const contacts = field(surfaceOf(scene, 0.3));
    contacts.update(0); runWorkers(); contacts.update(16);
    const worker = FakeWorker.all[0]!;
    expect(Math.abs(contactAt(contacts, 0.55, 0, 0))).toBeLessThan(0.1);
    // The move needs a larger texture; until that rebuild lands, the old texture and its bounds stay together.
    post.position.x = 3; frame();
    expect(contacts.update(100)).toBe(false);
    expect(contacts.texture).not.toBeNull();
    expect(Math.abs(contactAt(contacts, 0.55, 0, 0))).toBeLessThan(0.1);
    // Moves while it is in flight post nothing...
    post.position.x = 6; frame(); contacts.update(150);
    post.position.x = 9; frame(); contacts.update(200);
    expect(worker.jobs).toBe(2);
    // ...and once it lands, one rebuild follows with the latest pose.
    runWorkers();
    expect(contacts.update(250)).toBe(true);
    expect(Math.abs(contactAt(contacts, 3.55, 0, 0))).toBeLessThan(0.1);
    expect(worker.jobs).toBe(3);
    runWorkers();
    expect(contacts.update(300)).toBe(true);
    expect(Math.abs(contactAt(contacts, 9.55, 0, 0))).toBeLessThan(0.1);
    expect(contactAt(contacts, 3.55, 0, 0)).toBeGreaterThan(1.9);
  });

  it("starts a worker only for water that meets objects, and stops it with the last surface across scene switches", () => {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("Worker", FakeWorker);
    setup();
    const pond = createWaterMesh(scene, "pond", normalizeWaterBody({ width: 10, length: 10 }), createDefaultWaterDefinition());
    pond.position.x = -30; pond.computeWorldMatrix(true);
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
    frame(); clock += 250; updateSceneWater(scene);
    expect(FakeWorker.all).toHaveLength(0);
    // A lake around the post starts one; its contacts land once the worker replies.
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10 }), createDefaultWaterDefinition());
    expect(FakeWorker.all).toHaveLength(1);
    runWorkers(); clock += 16; updateSceneWater(scene);
    expect(Math.abs(contactAt(contactsOf(lake), 0.55, 0, 0))).toBeLessThan(0.15);
    // Closing the scene while a rebuild is in flight stops the worker.
    post.position.x = 0.3; frame(); clock += 50; updateSceneWater(scene);
    expect(FakeWorker.all[0]!.jobs).toBe(2);
    scene.dispose(); engine.dispose();
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    // The next scene's water starts a fresh one.
    setup();
    MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene).position.x = 0.3;
    frame();
    const next = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10 }), createDefaultWaterDefinition());
    expect(FakeWorker.all).toHaveLength(2);
    runWorkers(); clock += 16; updateSceneWater(scene);
    expect(Math.abs(contactAt(contactsOf(next), 0.85, 0, 0))).toBeLessThan(0.15);
    next.dispose();
    expect(FakeWorker.all[1]!.terminated).toBe(true);
  });

  it.each(["fails", "hangs"] as const)("rebuilds on the main thread when its worker %s, and tries a worker again after a scene switch", (failure) => {
    setup();
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    MeshBuilder.CreateBox("post", { width: 1, height: 4, depth: 1 }, scene);
    frame();
    const reference = field(surfaceOf(scene, 0.3));
    reference.update(0);
    const expected = view(reference).data!.slice();
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.mode = failure === "fails" ? "error" : "silent";
    const contacts = field(surfaceOf(scene, 0.3));
    expect(contacts.update(0)).toBe(false);
    runWorkers();
    // A failure is noticed when the worker reports it; a hang, when the job outlives the deadline. Either way the
    // worker stops and the objects, whose cuts it held, are cut again and rebuilt here.
    expect(contacts.update(failure === "fails" ? 16 : WATER_CONTACT_WORKER_TIMEOUT_MS)).toBe(true);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(differing(view(contacts).data, expected)).toBe(0);
    // While that surface lives, new ones stay on the main thread...
    expect(field(surfaceOf(scene, 0.3)).update(0)).toBe(true);
    expect(FakeWorker.all).toHaveLength(1);
    // ...and once every surface that saw the failure is gone, the next tries a worker again.
    for (const created of fields.splice(0)) created.dispose();
    FakeWorker.mode = "work";
    const next = field(surfaceOf(scene, 0.3));
    expect(next.update(0)).toBe(false);
    expect(FakeWorker.all).toHaveLength(2);
    runWorkers();
    expect(next.update(16)).toBe(true);
    expect(differing(view(next).data, expected)).toBe(0);
  });
});
