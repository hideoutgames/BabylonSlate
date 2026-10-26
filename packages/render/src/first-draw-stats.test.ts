import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, FresnelParameters, HemisphericLight, MeshBuilder, StandardMaterial, Vector3, type Scene } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { FIRST_DRAW_STALL_MS, openFirstDrawStats, trackFirstDraws } from "./first-draw-stats";

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
  /** One frame that takes `ms`, as the render loop draws it. */
  const frame = (ms = 16) => {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    now += ms;
  };
  return { engine, scene, frame };
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
    const { engine, scene, frame } = setup();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    frame();
    const before = session.stats().draws;
    session.pause();
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
    expect(session.stats()).toEqual({
      draws: 2, loadCompiled: 0, frames: 1, stalls: 1, mostInFrame: 2, worstFrameMs: FIRST_DRAW_STALL_MS + 80,
    });
    session.close();
  });

  it("leaves a WebGPU Engine untracked", () => {
    const { engine } = createTestEngine();
    Object.defineProperty(engine, "isWebGPU", { value: true });
    trackFirstDraws(engine);
    expect(openFirstDrawStats(engine)).toBeNull();
  });
});
