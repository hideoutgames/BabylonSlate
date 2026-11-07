import { mockCubeTextureIO } from "./texture-test-fixtures";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { enableHeadlessCascades } from "./shadow-test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { SNAPSHOT_FLAG_VISIBLE, snapshotFloatCount, writeActorSlot, writeSnapshotHeader } from "@haptic/bridge";
import {
  applyProjectQualityPatch, createDefaultScene, DEFAULT_RENDER_EFFECTS, normalizeRenderProjectSettings,
  qualityPresetPatch, QUALITY_GROUPS, ScalabilitySession, type QualityGroup, type RenderProjectSettings,
} from "@haptic/core";
import { createEngine } from "./create-engine";
import { releaseKeptEffects } from "./effect-bridge";
import { estimateTextureBytes } from "./texture-memory-estimate";

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly style = { cursor: "", touchAction: "" };
  focus(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  setPointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getContext(kind: string): unknown {
    if (kind === "2d") return { clearRect() {}, drawImage() {} };
    return null;
  }
}

/**
 * The project's High level with every screen effect on, as the Feature Test main scene plays: multisampled scene
 * colour and depth, the geometry pass with ambient occlusion, reflections, volumetrics and Screen-Space Shadows, bloom.
 */
const HIGH: RenderProjectSettings = (() => {
  const high = applyProjectQualityPatch(normalizeRenderProjectSettings({}), qualityPresetPatch("high"));
  const on = <T extends { enabled: boolean }>(effect: T) => ({ ...effect, enabled: true });
  return { ...high, effects: { ...DEFAULT_RENDER_EFFECTS, bloom: on(DEFAULT_RENDER_EFFECTS.bloom),
    ambientOcclusion: on(DEFAULT_RENDER_EFFECTS.ambientOcclusion), reflections: on(DEFAULT_RENDER_EFFECTS.reflections),
    volumetricLighting: on(DEFAULT_RENDER_EFFECTS.volumetricLighting) } };
})();
/** Above the harness's frame rate, so every Engine frame the view may draw is one it draws. */
const FRAME_CAP = 1000;

type Memory = { textures: number; bytes: number };

/**
 * GPU memory across Play's session quality changes, made as the Feature Test Check's Profile makes them: console
 * commands through the session's `ScalabilitySession`, each step undone by `quality reset` and its own restore.
 */
describe("Play quality changes", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (handles.length > 0) handles.pop()?.dispose();
    while (engines.length > 0) engines.pop()?.dispose();
  });

  function sharedEngine(): NullEngine {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engine.customAnimationFrameRequester = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
    mockCubeTextureIO(engine);
    // ThinEngine lists raw textures in its cache; NullEngine does not.
    const createRawTexture = engine.createRawTexture.bind(engine);
    engine.createRawTexture = (...args: Parameters<typeof createRawTexture>) => {
      const texture = createRawTexture(...args);
      engine.getLoadedTexturesCache().push(texture);
      return texture;
    };
    // What the spatial effects and 4x MSAA need.
    Object.assign(engine.getCaps(), {
      maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true,
      textureFloatRender: true, textureHalfFloatRender: true, texelFetch: true, maxMSAASamples: 4,
    });
    enableHeadlessCascades(engine);
    engines.push(engine);
    return engine;
  }

  /** The textures the Engine holds, as `estimateTextureMemory` counts them; NullEngine keeps released cache slots. */
  const live = (engine: NullEngine): InternalTexture[] => engine.getLoadedTexturesCache().filter((texture) => texture._references > 0);
  const memory = (engine: NullEngine): Memory => {
    const textures = live(engine);
    return { textures: textures.length, bytes: textures.reduce((sum, texture) => sum + estimateTextureBytes(texture), 0) };
  };

  /** A Play session at High: a lit crate under a shadowed sun, its view prepared and drawing. */
  async function startPlay() {
    const engine = sharedEngine();
    // The session submits to the view and the view acknowledges to the session, as Play wires them.
    const session = new ScalabilitySession(HIGH, FRAME_CAP, {}, (transaction) => play.applyCommand({ type: "setScalability", transaction }));
    const play = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine, playMode: true, renderSettings: HIGH, frameCap: FRAME_CAP,
      onScalabilityApplied: (acknowledgement) => session.acknowledge(acknowledgement),
    });
    handles.push(play);
    const scene = createDefaultScene();
    play.loadScene(scene, { sceneAssetGuid: "scene" });
    play.applySceneEnvironment(scene);
    const part = (componentId: string, meshKind: string) => ({ componentId, meshKind,
      position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
    play.applyCommand({ type: "spawn", slotId: 1, actorGuid: "crate", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 1, actorGuid: "crate", meshAssetGuid: null, meshKind: "box" });
    play.applyCommand({ type: "spawn", slotId: 2, actorGuid: "sun", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 2, meshAssetGuid: null, meshKind: null, actorGuid: "sun", parts: [
      { ...part("sun-light", "light:directional"), light: { color: [1, 1, 1], intensity: 1.5, enabled: true, castShadows: true } }] });
    play.applyCommand({ type: "spawn", slotId: 3, actorGuid: "camera", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 3, meshAssetGuid: null, meshKind: null, actorGuid: "camera", parts: [
      { ...part("lens", "camera"), camera: { fieldOfView: 60 } }] });
    // The runtime possesses the Scene's Default Camera when it starts.
    play.applyCommand({ type: "possessCamera", slotId: 3 });
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, { frameId: 1, tickIndex: 1, actorCount: 3, scriptMs: 0, physicsMs: 0 });
    const pose = (index: number, slotId: number, position: { x: number; y: number; z: number }, rotation = { x: 0, y: 0, z: 0, w: 1 }) =>
      writeActorSlot(snapshot, index, { slotId, position, rotation, scale: { x: 1, y: 1, z: 1 }, flags: SNAPSHOT_FLAG_VISIBLE });
    pose(0, 1, { x: 0, y: 1, z: 0 });
    pose(1, 2, { x: 5, y: 8, z: -5 }, { x: 0.3827, y: 0, z: 0, w: 0.9239 });
    pose(2, 3, { x: 0, y: 3, z: -10 });
    play.pushSnapshot(snapshot);

    /** Engine frames, as the browser runs them; the largest memory any of them ended with. */
    const frames = async (count: number): Promise<Memory> => {
      const peak = memory(engine);
      for (let frame = 0; frame < count; frame++) {
        if (!engine.getRenderingCanvas())
          vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
        engine.beginFrame(); engine._renderViews(); engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const now = memory(engine);
        peak.textures = Math.max(peak.textures, now.textures);
        peak.bytes = Math.max(peak.bytes, now.bytes);
      }
      return peak;
    };
    /** A console line as the Play console runs it: `quality …` through the session, `postprocessing` to the renderer. */
    const run = (line: string) => {
      const [name, ...words] = line.split(" ");
      if (name === "postprocessing") {
        play.applyCommand({ type: "setPostProcessingDebug", enabled: words[0] === "on" });
        return;
      }
      const group = QUALITY_GROUPS.includes(words[0] as QualityGroup) ? words.shift() as QualityGroup : undefined;
      expect(session.executeQuality(group, words[0], words[1]).success, line).toBe(true);
    };
    const work = () => {
      const diagnostics = play.renderDiagnostics();
      return { graphBuilds: diagnostics.rendererWork!.graphBuilds, drawn: diagnostics.presentation!.drawn };
    };
    await frames(20);
    return { engine, play, session, frames, run, work };
  }

  it("applies a change that changes no drawn setting with no texture, no graph build and no held frame", async () => {
    const { engine, play, session, frames, run, work } = await startPlay();
    /** Runs a console line or request, then ten frames: textures created, growth, graph builds and frames not drawn. */
    const step = async (change: string | (() => void)) => {
      const textures = new Set(live(engine));
      const before = { memory: memory(engine), ...work() };
      if (typeof change === "string") run(change);
      else change();
      const peak = await frames(10);
      const after = work();
      return {
        created: live(engine).filter((texture) => !textures.has(texture)).length,
        grown: { textures: peak.textures - before.memory.textures, bytes: peak.bytes - before.memory.bytes },
        graphBuilds: after.graphBuilds - before.graphBuilds,
        held: 10 - (after.drawn - before.drawn),
      };
    };
    const nothing = { created: 0, grown: { textures: 0, bytes: 0 }, graphBuilds: 0, held: 0 };
    // No session override to clear: the session sends the renderer nothing.
    expect(await step("quality reset")).toEqual(nothing);
    // Reflection Shadows are already off at High: only the shadow level's label changes, to Custom and back.
    expect(await step("quality shadows reflections off")).toEqual(nothing);
    expect(session.snapshot()).toMatchObject({ appliedRevision: 1, effective: { render: { shadows: { reflections: false, preset: "custom" } } } });
    expect(await step("quality reset")).toEqual(nothing);
    expect(session.snapshot()).toMatchObject({ appliedRevision: 2, effective: { render: { shadows: { reflections: false, preset: "high" } } } });
    // A game's Set Scalability writes the target frame rate the level already has: the resolution group turns Custom,
    // then back. The resolution level dynamic resolution (here Engine Settings) moved the view to stays.
    play.scaling.setSettingsLevel(1.25);
    await frames(10);
    expect(await step(() => session.request({ kind: "patch", render: { quality: { resolution: { targetFps: 60 } } } }))).toEqual(nothing);
    expect(session.snapshot()).toMatchObject({ appliedRevision: 3, effective: { render: { quality: { resolution: { preset: "custom" } } } } });
    expect(await step("quality reset")).toEqual(nothing);
    expect(play.scaling.getLevel()).toBe(1.25);
  });

  it("turns post-processing back on without compiling a program again, whatever Play's keep let go meanwhile", async () => {
    const { engine, frames, run } = await startPlay();
    const compiled = () => new Map(Object.entries((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects));
    const before = compiled();
    run("postprocessing off");
    await frames(20);
    // The keep lets go of what was not drawn lately once a scene's programs outnumber its budget; here it lets go of
    // all of them.
    releaseKeptEffects(engine);
    run("postprocessing on");
    await frames(20);
    const after = compiled();
    // Every program drawn before is the same Effect again: none compiled a second time.
    const compiledAgain = [...before].filter(([key, effect]) => after.get(key) !== effect).length;
    expect({ programs: before.size, compiledAgain }).toEqual({ programs: 20, compiledAgain: 0 });
    // The hold ends once the view draws with post-processing on again: back at Medium shadows, the programs only High
    // draws go with the keep.
    run("postprocessing off");
    await frames(20);
    run("quality shadows medium");
    run("postprocessing on");
    await frames(20);
    releaseKeptEffects(engine);
    await frames(5);
    const medium = compiled();
    // The Screen-Space Shadows stage and a surface variant Medium does not draw; a hold that never ended keeps both.
    expect([...before.keys()].filter((key) => !medium.has(key))).toHaveLength(2);
  });

  it("never holds more textures than the larger of the states before and after a step or its restore", async () => {
    const { engine, frames, run } = await startPlay();
    const counts: Record<string, { before: number; peak: number; after: number }> = {};
    const step = async (label: string, lines: string[]) => {
      const before = memory(engine);
      for (const line of lines) run(line);
      const peak = await frames(20);
      const after = memory(engine);
      counts[label] = { before: before.textures, peak: peak.textures, after: after.textures };
      // Bytes too: the replaced graph's targets go before its replacement allocates, and nothing else allocates.
      expect(peak.bytes, label).toBeLessThanOrEqual(Math.max(before.bytes, after.bytes));
    };
    // The Profile's order: each step, then `quality reset` and the step's own restore. A session quality change
    // retains the replaced graph until its replacement presents; a post-processing switch replaces it at once.
    await step("MSAA off", ["quality postprocessing antialiasing off"]);
    await step("MSAA restore", ["quality reset"]);
    await step("post off", ["postprocessing off"]);
    await step("post restore", ["quality reset", "postprocessing on"]);
    await step("shadows medium", ["quality shadows medium"]);
    await step("shadows restore", ["quality reset"]);
    await step("MSAA and post off", ["quality postprocessing antialiasing off", "postprocessing off"]);
    await step("MSAA and post restore", ["quality reset", "postprocessing on"]);
    // 21 at High: the 13 the view's graph allocates (multisampled scene colour and depth, geometry buffers, the spatial
    // stages' and bloom's targets) and 8 the session holds besides (the sun's shadow atlas among them). Post off
    // leaves the multisampled scene colour and depth, and with MSAA off too the view draws into the backbuffer; Medium
    // shadows draw no Screen-Space Shadows, one target fewer. The peak is the larger state, with no allowance above it.
    expect(counts).toEqual({
      "MSAA off": { before: 21, peak: 21, after: 21 },
      "MSAA restore": { before: 21, peak: 21, after: 21 },
      "post off": { before: 21, peak: 10, after: 10 },
      "post restore": { before: 10, peak: 21, after: 21 },
      "shadows medium": { before: 21, peak: 21, after: 20 },
      "shadows restore": { before: 20, peak: 21, after: 21 },
      "MSAA and post off": { before: 21, peak: 8, after: 8 },
      "MSAA and post restore": { before: 8, peak: 21, after: 21 },
    });
  });
});
