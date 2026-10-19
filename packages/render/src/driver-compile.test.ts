import { afterEach, describe, expect, it } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, ObjectRenderer, Scene, Vector3, type AbstractMesh, type Effect } from "@babylonjs/core";
import {
  COMPILE_AHEAD_LIMIT, DriverCompileWatch, pendingDriverCompiles, readinessScanMeshes, requestCompilesAhead,
} from "./driver-compile";
import { SCENE_DRIVER_COMPILE_TIMEOUT_MS, SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";

function engineWith(parallel: boolean) {
  const engine = new NullEngine();
  if (parallel) engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  const add = (key: string, state: { ready?: boolean; error?: string } = {}) => {
    const entry = { ready: false, error: "", ...state };
    effects[key] = { isReady: () => entry.ready, getCompilationError: () => entry.error } as unknown as Effect;
    return entry;
  };
  return { engine, add };
}

describe("driver compile watch", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
  const setup = (parallel = true) => {
    const made = engineWith(parallel);
    engines.push(made.engine);
    return made;
  };

  it("lists only effects the driver is still compiling", () => {
    const { engine, add } = setup();
    add("ready", { ready: true });
    add("failed", { error: "link error" });
    add("compiling");
    expect(pendingDriverCompiles(engine)).toEqual(["compiling"]);
  });

  it("sees nothing pending without parallel shader compile", () => {
    const { engine, add } = setup(false);
    add("compiling");
    expect(pendingDriverCompiles(engine)).toEqual([]);
    expect(new DriverCompileWatch(engine).renew()).toBe(false);
  });

  it("renews while a cascade of compiles keeps changing the pending set", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    const step = SCENE_DRIVER_COMPILE_TIMEOUT_MS / 2;
    const first = add("first");
    expect(watch.renew(0)).toBe(true);
    first.ready = true;
    add("second");
    expect(watch.renew(step)).toBe(true);
    expect(watch.renew(step * 2 + 1)).toBe(true);
  });

  it("stops renewing when the same effects stay pending for the compile bound", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    add("hung");
    expect(watch.renew(0)).toBe(true);
    expect(watch.renew(SCENE_DRIVER_COMPILE_TIMEOUT_MS - 1)).toBe(true);
    expect(watch.renew(SCENE_DRIVER_COMPILE_TIMEOUT_MS)).toBe(false);
  });

  it("renews once for a compile that finished, and not again while nothing is pending or finishing", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    const effect = add("done");
    expect(watch.renew(0)).toBe(true);
    effect.ready = true;
    expect(watch.renew(1)).toBe(true);
    expect(watch.renew(2)).toBe(false);
  });

  // Synchronous links (SwiftShader; WebKit, which exposes parallel compile but links inside the call) never leave
  // anything pending: variants that finished since the last renewal are the only sign of progress.
  it.each([false, true])("renews for variants that finished since the last renewal (parallel compile exposed: %s)", (parallel) => {
    const { engine, add } = setup(parallel);
    add("before the watch", { ready: true });
    const watch = new DriverCompileWatch(engine);
    expect(watch.renew(0)).toBe(false);
    add("first link", { ready: true });
    add("second link", { ready: true });
    expect(watch.renew(1)).toBe(true);
    expect(watch.renew(2)).toBe(false);
    add("third link", { ready: true });
    expect(watch.renew(3)).toBe(true);
    expect(watch.describe()).toContain("Shaders: 3 compiled while waiting, 0 still compiling, 4 on the Engine");
  });

  it("does not count a released variant compiled again as progress", () => {
    const { engine, add } = setup(false);
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const watch = new DriverCompileWatch(engine);
    add("variant", { ready: true });
    expect(watch.renew(0)).toBe(true);
    delete effects["variant"];
    add("variant", { ready: true });
    expect(watch.renew(1)).toBe(false);
  });

  it("renews nothing from its ceiling on, however much keeps compiling", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine, 0);
    expect(watch.ceiling).toBe(SCENE_PREPARATION_CEILING_MS);
    add("pending");
    add("finished", { ready: true });
    expect(watch.renew(SCENE_PREPARATION_CEILING_MS - 1)).toBe(true);
    add("finished later", { ready: true });
    expect(watch.renew(SCENE_PREPARATION_CEILING_MS)).toBe(false);
  });
});

describe("compiles requested ahead of a readiness scan", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

  /**
   * A scan over boxes `mesh-0`… that waits on `mesh-0`, whose compile it started. Probing a mesh that `ready` does not
   * name starts its compile, pending on the driver until settled; `probed` lists the probes in order.
   */
  function scan(count: number, { parallel = true, ready = [] as string[] } = {}) {
    const made = engineWith(parallel);
    engines.push(made.engine);
    const scene = new Scene(made.engine);
    const meshes = Array.from({ length: count }, (_, index) => MeshBuilder.CreateBox(`mesh-${index}`, {}, scene));
    const compiles = new Map([["mesh-0", made.add("mesh-0")]]);
    const probed: string[] = [];
    const probe = (mesh: AbstractMesh) => {
      probed.push(mesh.name);
      if (ready.includes(mesh.name)) return true;
      if (!compiles.has(mesh.name)) compiles.set(mesh.name, made.add(mesh.name));
      return false;
    };
    const names = (from: number, to: number) => meshes.slice(from, to).map((mesh) => mesh.name);
    return {
      engine: made.engine, meshes, names, probed, requested: new Set<AbstractMesh>(),
      ahead: (requested: Set<AbstractMesh>, headRest?: (head: AbstractMesh) => boolean) =>
        requestCompilesAhead(made.engine, meshes, meshes[0]!, requested, probe, headRest),
      settle: (name: string) => { compiles.get(name)!.ready = true; },
    };
  }

  it("probes the meshes after the one the scan waits on until the limit of compiles is pending", () => {
    const { engine, names, probed, requested, ahead } = scan(COMPILE_AHEAD_LIMIT + 3);
    ahead(requested);
    expect(probed).toEqual(names(1, COMPILE_AHEAD_LIMIT));
    expect(pendingDriverCompiles(engine)).toHaveLength(COMPILE_AHEAD_LIMIT);
  });

  it("passes meshes that are already ready, which start no compile", () => {
    const { engine, names, probed, requested, ahead } = scan(COMPILE_AHEAD_LIMIT + 3, { ready: ["mesh-1", "mesh-2"] });
    ahead(requested);
    expect(probed).toEqual(names(1, COMPILE_AHEAD_LIMIT + 2));
    expect(pendingDriverCompiles(engine)).toHaveLength(COMPILE_AHEAD_LIMIT);
  });

  it("probes each mesh once until the owner clears the set, and the next one as a pending compile settles", () => {
    const { names, probed, requested, ahead, settle } = scan(COMPILE_AHEAD_LIMIT + 3);
    ahead(requested);
    probed.length = 0;
    ahead(requested);
    expect(probed).toEqual([]);
    settle("mesh-1");
    ahead(requested);
    expect(probed).toEqual(names(COMPILE_AHEAD_LIMIT, COMPILE_AHEAD_LIMIT + 1));
  });

  it("requests the head's skipped variants first, once, within the same limit", () => {
    const { engine, names, probed, requested, ahead } = scan(COMPILE_AHEAD_LIMIT + 3);
    const add = (key: string) => {
      (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects[key] =
        { isReady: () => false, getCompilationError: () => "" } as unknown as Effect;
    };
    // The head's depth pre-pass, say, which its colour variant holds back.
    const headRest = (head: AbstractMesh) => { probed.push(`${head.name} rest`); add(`${head.name} rest`); return false; };
    ahead(requested, headRest);
    ahead(requested, headRest);
    expect(probed).toEqual(["mesh-0 rest", ...names(1, COMPILE_AHEAD_LIMIT - 1)]);
    expect(pendingDriverCompiles(engine)).toHaveLength(COMPILE_AHEAD_LIMIT);
  });

  it("skips the meshes the scan skips", () => {
    const { meshes, probed, requested, ahead } = scan(4);
    meshes[1]!.setEnabled(false);
    meshes[2]!.isVisible = false;
    ahead(requested);
    expect(probed).toEqual(["mesh-3"]);
  });

  it("requests nothing ahead without parallel compile, where every request links inside the call", () => {
    const { probed, requested, ahead } = scan(4, { parallel: false });
    const rest: string[] = [];
    ahead(requested, (head) => { rest.push(head.name); return false; });
    expect(probed).toEqual([]);
    expect(rest).toEqual([]);
  });

  it("walks the meshes a renderer without a render list scans: outside a frame graph, the scene's active ones", () => {
    const { engine } = engineWith(true);
    engines.push(engine);
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    const inView = MeshBuilder.CreateBox("in view", {}, scene);
    MeshBuilder.CreateBox("behind the camera", {}, scene).position.z = -20;
    scene.render();
    const renderer = new ObjectRenderer("probe", scene);
    renderer.renderList = null;
    expect(readinessScanMeshes(renderer, scene)).toEqual([inView]);
    renderer.renderList = [inView];
    expect(readinessScanMeshes(renderer, scene)).toBe(renderer.renderList);
    renderer.dispose();
  });
});
