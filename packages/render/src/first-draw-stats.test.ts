import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createTestEngine } from "./test-support/test-engine";
import { beginDrawPassFrame, DrawPassFrame, endDrawPassFrame, withDrawPass } from "./draw-passes";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { FIRST_DRAW_STALL_MS, LONG_FRAMES_KEPT, openFirstDrawStats, programInventory, programVariants, trackFirstDraws } from "./first-draw-stats";

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

  it("counts each first draw to the pass that made it, in the session and in its long frame", async () => {
    const { engine, scene, frame } = setup();
    frame();
    const session = openFirstDrawStats(engine)!;
    session.resume();
    const spawned = MeshBuilder.CreateBox("spawned", {}, scene);
    spawned.material = variant(scene, "unlit", "unlit");
    await spawned.material.forceCompilationAsync(spawned);
    const passes = new DrawPassFrame(engine as unknown as ConstructorParameters<typeof DrawPassFrame>[0]);
    // The view attributes its frame, and draws the Scene inside its shadow pass: a long frame.
    frame(FIRST_DRAW_STALL_MS + 20, 0, () => {
      beginDrawPassFrame(passes);
      withDrawPass(engine, "shadows", () => scene.render());
      endDrawPassFrame(passes);
      spawned.setEnabled(false);
    });
    // Outside any view's attributed frame a first draw counts to `other`.
    const late = MeshBuilder.CreateBox("late", {}, scene);
    late.material = variant(scene, "fresnel", "fresnel");
    await late.material.forceCompilationAsync(late);
    frame();
    frame();
    const stats = session.stats();
    expect(stats.passes).toEqual({ shadows: 1, other: 1 });
    expect(stats.longest.map((entry) => entry.passes)).toEqual([{ shadows: 1 }]);
    session.close();
  });

  it("inventories the Engine's programs: those it never drew, and the rest by the pass that first drew each", async () => {
    const { engine, scene, frame } = setup();
    const held = () => Object.keys((engine as unknown as { _compiledEffects: object })._compiledEffects).length;
    const before = held();
    const shadowed = MeshBuilder.CreateBox("shadowed", {}, scene);
    shadowed.material = variant(scene, "unlit", "unlit");
    const unseen = MeshBuilder.CreateBox("unseen", {}, scene);
    unseen.material = variant(scene, "fresnel", "fresnel");
    unseen.setEnabled(false);
    await shadowed.material.forceCompilationAsync(shadowed);
    await unseen.material.forceCompilationAsync(unseen);
    expect(held()).toBe(before + 2);
    // Compiled, none drawn yet.
    expect(programInventory(engine)).toMatchObject({ programs: before + 2, neverDrawn: before + 2, passes: {} });
    const passes = new DrawPassFrame(engine as unknown as ConstructorParameters<typeof DrawPassFrame>[0]);
    frame(16, 0, () => {
      beginDrawPassFrame(passes);
      withDrawPass(engine, "shadows", () => scene.render());
      endDrawPassFrame(passes);
    });
    // The pass that drew it first keeps it, however often another draws it afterwards.
    frame();
    expect(programInventory(engine)).toMatchObject({ programs: before + 2, neverDrawn: before + 1, passes: { shadows: 1 } });
  });

  it("names what splits a shader into several programs: each define that differs between them, with those that split the same shaders", () => {
    const effect = (name: string | { vertex?: string; fragment?: string; vertexSource?: string; fragmentSource?: string }, ...defines: string[]) =>
      ({ name, defines: defines.map((define) => `#define ${define}`).join("\n") }) as unknown as Effect;
    const unnamed = (vertexSource: string, fragmentSource: string, ...defines: string[]) => effect({ vertexSource, fragmentSource }, ...defines);
    const variants = programVariants([
      // A Material's colour and geometry programs: the geometry pass defines two things the colour pass does not.
      effect("matA", "PREPASS_DEPTH_INDEX 0", "PREPASS", "NUM_BONE_INFLUENCERS 0"),
      effect("matA", "NUM_BONE_INFLUENCERS 0"),
      // Another's plain, instanced and instanced geometry programs: all three hold FOG, which splits nothing.
      effect({ vertex: "matB", fragment: "matB" }, "INSTANCES", "FOG"),
      effect({ vertex: "matB", fragment: "matB" }, "FOG"),
      effect({ vertex: "matB", fragment: "matB" }, "INSTANCES", "FOG", "PREPASS", "PREPASS_DEPTH_INDEX 1"),
      // A shader with one program.
      effect("post"),
      // Unnamed shaders are told apart by their sources, the vertex one and the fragment one: three shaders here, the
      // first with a plain and an instanced program, the second with two that differ by a define's value alone.
      unnamed("void main() {}", "void main() { discard; }", "INSTANCES"),
      unnamed("void main() {}", "void main() { discard; }"),
      unnamed("void main() { gl_Position = vec4(0.0); }", "void main() { discard; }", "NUM_BONE_INFLUENCERS 0"),
      unnamed("void main() { gl_Position = vec4(0.0); }", "void main() { discard; }", "NUM_BONE_INFLUENCERS 4"),
      unnamed("void main() {}", "void main() {}", "FOG"),
    ]);
    expect(variants).toEqual({
      shaders: 6, mostVariants: 3,
      // Most shaders first, then by name. INSTANCES splits matB and the first unnamed shader. The two geometry defines
      // split the same two shaders (matA and matB): one cause, named by the shorter. The bone count splits one.
      splitBy: [
        { define: "INSTANCES", with: [], shaders: 2 },
        { define: "PREPASS", with: ["PREPASS_DEPTH_INDEX"], shaders: 2 },
        { define: "NUM_BONE_INFLUENCERS", with: [], shaders: 1 },
      ],
    });
  });

  it("reports what the Engine's programs are variants of with its inventory, as they are now", async () => {
    const { engine, scene } = setup();
    const effects = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects);
    const variants = () => {
      const { shaders, mostVariants, splitBy } = programInventory(engine)!;
      return { shaders, mostVariants, splitBy };
    };
    const before = variants();
    expect(before).toEqual(programVariants(effects()));
    // A program compiled since: the inventory follows the Engine's programs, not what it once computed.
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = variant(scene, "unlit", "unlit");
    await box.material.forceCompilationAsync(box);
    expect(variants()).toEqual(programVariants(effects()));
    expect(variants().shaders).toBe(before.shaders + 1);
  });

  it("has no inventory for an Engine whose draws are not tracked", () => {
    const { engine } = createTestEngine();
    expect(programInventory(engine)).toBeNull();
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
