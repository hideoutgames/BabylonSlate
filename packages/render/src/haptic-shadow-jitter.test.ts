import { DEFAULT_RENDER_EFFECTS } from "@haptic/core";
import { MeshBuilder, NullEngine, Observable, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hapticShadowGlsl, hapticShadowWgsl } from "./haptic-lighting-shader";
import { forceViewTerms, viewTermsForPass } from "./haptic-view-inputs";
import { compileMaterialPlan } from "./material-compiler";
import { setSceneRenderSettings } from "./scene-render-mode";
import { TemporalJitter } from "./temporal-anti-aliasing";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function host() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 1, -5), scene);
  return scene;
}

const temporal = (enabled: boolean) => ({
  ...DEFAULT_RENDER_EFFECTS,
  temporalAntiAliasing: { ...DEFAULT_RENDER_EFFECTS.temporalAntiAliasing, enabled },
});

describe("shadow filter jitter", () => {
  it("is compiled into a frozen lit Material exactly while temporal anti-aliasing is on", async () => {
    const scene = host();
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    const material = compiled.material;
    const mesh = MeshBuilder.CreateBox("box", {}, scene);
    mesh.material = material;
    const jitters = async () => {
      scene.incrementRenderId();
      await material.forceCompilationAsync(mesh);
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
      return /^#define HAPTIC_SHADOW_JITTER$/m.test(mesh.subMeshes[0]!.effect!.defines);
    };
    expect(await jitters()).toBe(false);
    material.freeze();
    setSceneRenderSettings(scene, { effects: temporal(true) });
    expect(await jitters()).toBe(true);
    // Other effects leave it alone.
    setSceneRenderSettings(scene, { effects: { ...temporal(true), fxaa: true } });
    expect(await jitters()).toBe(true);
    setSceneRenderSettings(scene, { effects: temporal(false) });
    expect(await jitters()).toBe(false);
    expect(material.isFrozen).toBe(true);
    compiled.dispose();
  });

  it("runs at amplitude 1 and the jitter's sample index only in the passes the temporal jitter jitters", () => {
    const scene = host();
    const renderer = {
      renderPassId: 41,
      activeCamera: null,
      onBeforeRenderingManagerRenderObservable: new Observable(),
      onFinishRenderingObservable: new Observable(),
    } as unknown as ObjectRenderer;
    const jitter = new TemporalJitter(scene, scene.activeCamera!, 8, 64, 64);
    jitter.jitterRenderer(renderer);
    expect(viewTermsForPass(scene, 41)).toEqual({ jitterAmplitude: 1, jitterPhase: 0 });
    jitter.projection();
    expect(jitter.sampleIndex).toBe(1);
    expect(viewTermsForPass(scene, 41)).toEqual({ jitterAmplitude: 1, jitterPhase: 1 });
    scene.incrementRenderId();
    (scene as unknown as { _frameId: number })._frameId++;
    jitter.projection();
    expect(viewTermsForPass(scene, 41).jitterPhase).toBe(2);
    // Another pass (a capture, a mirror, a probe) draws the fixed pattern.
    expect(viewTermsForPass(scene, 42)).toEqual({ jitterAmplitude: 0, jitterPhase: 0 });
    // A proof forces every pass.
    forceViewTerms(scene, { jitterAmplitude: 1, jitterPhase: 5 });
    expect(viewTermsForPass(scene, 42)).toEqual({ jitterAmplitude: 1, jitterPhase: 5 });
    forceViewTerms(scene, null);
    jitter.dispose();
    expect(viewTermsForPass(scene, 41)).toEqual({ jitterAmplitude: 0, jitterPhase: 0 });
  });

  it.each([["GLSL", hapticShadowGlsl], ["WGSL", hapticShadowWgsl]] as const)(
    "shifts the %s PCF kernel's centre while its receiver plane stays at the position's texel",
    (_, shader) => {
      // Source text is the contract here: the define's branch and its twin without it.
      const text = shader(true);
      const [withJitter, without] = text.slice(text.search(/(vec2|let) origin = uv \* size;/)).split("\n#else\n");
      // Every receiver-plane tap compares against the unshifted origin under the define, the texels themselves without.
      const taps = (branch: string, origin: string) => branch.split(`, ${origin}, depth, gradient, maximum)`).length - 1;
      // Medium's four and high's nine taps.
      expect([taps(withJitter!, "origin"), taps(withJitter!, "texels")]).toEqual([13, 0]);
      expect([taps(without!, "origin"), taps(without!, "texels")]).toEqual([0, 13]);
      // A volume's march (no surface) never jitters.
      expect(shader(false)).not.toContain("hapticShadowShift()");
    },
  );
});
