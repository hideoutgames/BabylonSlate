import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, FresnelParameters, HemisphericLight, MeshBuilder, StandardMaterial, Vector3, type Scene } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { FIRST_DRAW_STALL_MS, LONG_FRAMES_KEPT, openFirstDrawStats, trackFirstDraws } from "./first-draw-stats";

/** A Standard Material whose defines differ from a plain lit one's, so it compiles an Effect of its own. */
function variant(scene: Scene, name: string, define: "unlit" | "fresnel"): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  if (define === "unlit") material.disableLighting = true;
  else material.emissiveFresnelParameters = new FresnelParameters();
  return material;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const { engine, scene } = createTestEngine();
  new ArcRotateCamera("camera", 0, 1, 10, Vector3.Zero(), scene);
  new HemisphericLight("light", Vector3.Up(), scene);
  trackFirstDraws(engine);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  /** One frame that takes `ms`, `engineMs` of it inside the Engine's frame, as the render loop draws it. */
  const frame = (ms = 16, engineMs = 0, during?: () => void) => {
    engine.beginFrame();
    during?.();
    scene.render();
    now += engineMs;
    engine.endFrame();
    now += ms - engineMs;
  };
  return { engine, scene, frame, advance: (ms: number) => { now += ms; } };
}

describe("first draw stats", () => {
  it("counts Effects first drawn while counting, and which of them the load compiled without drawing", async () => {
    const { engine, scene, frame } = setup();
    const drawn = MeshBuilder.CreateBox("drawn", {}, scene);
    drawn.material = new StandardMaterial("standard", scene);
    const offscreen = MeshBuilder.CreateBox("offscreen", {}, scene);
    offscreen.material = variant(scene, "fresnel", "fresnel");
    offscreen.setEnabled(false);
    // The load compiles both and draws only what it shows.
    await offscreen.material.forceCompilationAsync(offscreen);
    frame();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    frame();
    expect(session.stats().draws).toBe(0);

    offscreen.setEnabled(true);
    frame();
    expect(session.stats()).toMatchObject({ draws: 1, loadCompiled: 1 });

    const spawned = MeshBuilder.CreateBox("spawned", {}, scene);
    spawned.material = variant(scene, "unlit", "unlit");
    await spawned.material.forceCompilationAsync(spawned);
    frame();
    expect(session.stats()).toMatchObject({ draws: 2, loadCompiled: 1 });
    session.close();
  });

  it("does not count while paused, and a shader drawn then is not counted later", async () => {
    const { engine, scene, frame, advance } = setup();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    frame();
    const before = session.stats().draws;
    // The frame a pause cuts short is not a long frame, however long since it began.
    advance(500);
    session.pause();
    expect(session.stats().longFrames).toBe(0);
    const loaded = MeshBuilder.CreateBox("loaded", {}, scene);
    loaded.material = variant(scene, "unlit", "unlit");
    await loaded.material.forceCompilationAsync(loaded);
    frame();
    expect(scene.getActiveMeshes().data).toContain(loaded);
    session.resume();
    frame();
    expect(session.stats().draws).toBe(before);
    session.close();
  });

  it("times the frames that hold first draws, from their start to the next frame's", async () => {
    const { engine, scene, frame } = setup();
    MeshBuilder.CreateBox("steady", {}, scene).material = new StandardMaterial("standard", scene);
    frame();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    frame(16);
    for (const [mesh, define] of [[MeshBuilder.CreateBox("a", {}, scene), "fresnel"], [MeshBuilder.CreateSphere("b", {}, scene), "unlit"]] as const) {
      mesh.material = variant(scene, define, define);
      await mesh.material.forceCompilationAsync(mesh);
    }
    frame(FIRST_DRAW_STALL_MS + 80);
    frame(16);
    expect(session.stats()).toMatchObject({
      draws: 2, loadCompiled: 0, frames: 1, stalls: 1, mostInFrame: 2, worstFrameMs: FIRST_DRAW_STALL_MS + 80,
    });
    session.close();
  });

  it("keeps the longest frames, with their time in the Engine's frame, first draws and compiles", async () => {
    const { engine, scene, frame } = setup();
    MeshBuilder.CreateBox("steady", {}, scene).material = new StandardMaterial("standard", scene);
    frame();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    frame(16);
    for (const [mesh, define] of [[MeshBuilder.CreateBox("a", {}, scene), "fresnel"], [MeshBuilder.CreateSphere("b", {}, scene), "unlit"]] as const) {
      mesh.material = variant(scene, define, define);
      await mesh.material.forceCompilationAsync(mesh);
    }
    // Two first draws in a frame spent mostly inside the Engine's.
    frame(180, 150);
    // A compile in a frame spent mostly outside it; the mesh is hidden, so nothing draws for the first time.
    const hidden = MeshBuilder.CreateBox("hidden", {}, scene);
    const material = variant(scene, "hidden", "fresnel");
    material.disableLighting = true;
    hidden.material = material;
    hidden.setEnabled(false);
    frame(300, 20, () => void hidden.material!.forceCompilationAsync(hidden));
    frame(16);
    expect(session.stats()).toMatchObject({
      longFrames: 2,
      longest: [{ ms: 300, engineMs: 20, firstDraws: 0, compiles: 1 }, { ms: 180, engineMs: 150, firstDraws: 2, compiles: 0 }],
    });

    for (let index = 0; index < LONG_FRAMES_KEPT; index++) frame(FIRST_DRAW_STALL_MS + 10);
    frame(16);
    const { longFrames, longest } = session.stats();
    expect([longFrames, longest.length, longest[0]!.ms, longest[1]!.ms, longest.at(-1)!.ms])
      .toEqual([2 + LONG_FRAMES_KEPT, LONG_FRAMES_KEPT, 300, 180, FIRST_DRAW_STALL_MS + 10]);
    session.close();
  });

  it("leaves a WebGPU Engine untracked", () => {
    const { engine } = createTestEngine();
    Object.defineProperty(engine, "isWebGPU", { value: true });
    trackFirstDraws(engine);
    expect(openFirstDrawStats(engine)).toBeNull();
  });
});
