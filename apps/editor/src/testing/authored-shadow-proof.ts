/** Test-only WPO shadow comparison against physically translated native geometry. */
import {
  CascadedShadowGenerator, Color3, Color4, DirectionalLight, Engine, FreeCamera, HemisphericLight,
  Material, MeshBuilder, PBRMaterial, PointLight, RawTexture, Scene, ShadowGenerator, StandardMaterial, Texture, Vector3, VertexBuffer, type Effect,
} from "@babylonjs/core";
import { compileMaterialPlan, createAppWebGpuEngine, disposeMeshLatticeDeformer, setMeshLatticeDeformer, setSceneRenderSettings } from "@babylonslate/render";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { shadowSurfaceSamples, type ShadowBox, type ShadowTriple } from "./shadow-self-shadowing-fixture";

export async function runAuthoredShadowProof(backend: "webgl2" | "webgpu", kind: "directional" | "point" | "cascades") {
  const size = 256;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  let disposeAuthored: (() => Promise<void>) | undefined;
  try {
    engine.setSize(size, size);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("Receiver Camera", new Vector3(-4, 4, -6), scene);
    camera.setTarget(new Vector3(0, 0.5, 0)); camera.minZ = 0.1; camera.maxZ = 30;
    scene.activeCamera = camera;
    const direction = new Vector3(0.7, -1, 0.5).normalize();
    const light = kind === "point" ? new PointLight("Local Shadow", new Vector3(-2, 5, -2), scene)
      : new DirectionalLight("Directional Shadow", direction, scene);
    light.position.set(-2, 5, -2); light.intensity = 1.5;
    light.shadowMinZ = 0.1; light.shadowMaxZ = 20;
    if (light instanceof DirectionalLight) { light.shadowFrustumSize = 10; light.autoCalcShadowZBounds = false; }
    new HemisphericLight("Fill", Vector3.Up(), scene).intensity = 0.2;
    const native = new StandardMaterial("Native Reference", scene);
    native.diffuseColor = new Color3(0.6, 0.6, 0.6); native.specularColor = Color3.Black();
    const ground = MeshBuilder.CreateGround("Receiver", { width: 12, height: 12 }, scene);
    ground.material = native; ground.receiveShadows = true;
    const caster = MeshBuilder.CreateBox("Displaced Caster", { size: 1 }, scene);
    caster.position.y = 0.8; caster.material = native; caster.alwaysSelectAsActiveMesh = true;
    const generator = kind === "cascades" ? new CascadedShadowGenerator(512, light as DirectionalLight)
      : new ShadowGenerator(512, light);
    if (generator instanceof CascadedShadowGenerator) { generator.numCascades = 2; generator.stabilizeCascades = true; }
    generator.bias = 0.001; generator.normalBias = 0.03;
    generator.addShadowCaster(caster);
    const document = createDefaultMaterialDocument("Authored Shadow");
    document.shadingModel = "unlit"; document.blendMode = "masked"; document.alphaCutoff = 0.5;
    document.nodes.push(
      { id: "shift", type: "param.float", properties: { name: "Shift", value: [0.8] }, position: { x: 0, y: 0 } },
      { id: "cutout", type: "param.float", properties: { name: "Cutout", value: [1] }, position: { x: 0, y: 0 } },
      { id: "offset", type: "vector.combine", properties: {}, position: { x: 0, y: 0 } },
    );
    document.edges.push(
      { id: "shift-offset", sourceNodeId: "shift", sourcePinId: "out", targetNodeId: "offset", targetPinId: "x" },
      { id: "offset-output", sourceNodeId: "offset", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "worldPositionOffset" },
      { id: "cutout-output", sourceNodeId: "cutout", sourcePinId: "out", targetNodeId: "output", targetPinId: "alphaClip" },
    );
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const authored = compileMaterialPlan(lowered.plan, { scene, name: "Authored Shadow" });
    if (!authored.ok) throw new Error(JSON.stringify(authored.diagnostics));
    disposeAuthored = authored.whenReleased;
    const diagnostics = await authored.ready;
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    authored.material.freeze();
    const shadowEffects = new Set<Effect>();
    const programs = new Map<string, unknown>();
    generator.onBeforeShadowMapRenderObservable.add((effect) => {
      const source = caster.material!;
      const context = effect.getPipelineContext() as {
        uniformBuffer?: { getData(): Float32Array };
        shaderProcessingContext?: { leftOverUniforms?: unknown };
        program?: WebGLProgram;
      } | null;
      const gl = (engine as Engine & { _gl?: WebGLRenderingContext })._gl;
      const uniforms = gl && context?.program ? Object.fromEntries(effect.getUniformNames().map((name) => {
        const location = gl.getUniformLocation(context.program!, name);
        const value: unknown = location ? gl.getUniform(context.program!, location) : null;
        return [name, ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : value];
      })) : undefined;
      programs.set(`${source.name}:${effect.defines}`, {
        material: source.name, defines: effect.defines,
        vertex: effect.vertexSourceCode, fragment: effect.fragmentSourceCode,
        uniforms, uniformLayout: context?.shaderProcessingContext?.leftOverUniforms,
        uniformData: context?.uniformBuffer ? Array.from(context.uniformBuffer.getData()) : undefined,
        viewProjection: Array.from(scene.getTransformMatrix().asArray()),
      });
    });
    const render = async () => {
      const deadline = performance.now() + 15000;
      let coherent = 0;
      do {
        engine.beginFrame(); scene.render(); engine.endFrame();
        // Probe the actual shadow pass without poisoning the main draw wrapper.
        const previousPass = engine.currentRenderPassId;
        engine.currentRenderPassId = generator.getShadowMap()!.renderPassId;
        let ready: boolean;
        try { ready = generator.isReady(caster.subMeshes![0]!, false, false); }
        finally { engine.currentRenderPassId = previousPass; }
        ready &&= caster.material!.isReadyForSubMesh(caster, caster.subMeshes![0]!);
        ready &&= ground.material!.isReadyForSubMesh(ground, ground.subMeshes![0]!);
        coherent = ready ? coherent + 1 : 0;
        if (coherent >= 3) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < deadline);
      if (coherent < 3) throw new Error(`Authored shadow shaders did not become ready: ${backend} ${kind}`);
      if (caster.material?.shadowDepthWrapper) {
        const effect = caster.material.shadowDepthWrapper.getEffect(caster.subMeshes![0]!, generator, generator.getShadowMap()!.renderPassId)?.effect;
        if (effect) shadowEffects.add(effect);
      }
      const read = await engine.readPixels(0, 0, size, size);
      const bytes = new Uint8Array(read.buffer, read.byteOffset, read.byteLength);
      const pixels = new Uint8Array(bytes.length);
      const format = (engine.getCreationOptions() as { swapChainFormat?: string }).swapChainFormat;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const source = (y * size + x) * 4, target = ((backend === "webgl2" ? size - 1 - y : y) * size + x) * 4;
        pixels[target] = bytes[source + (format === "bgra8unorm" ? 2 : 0)]!;
        pixels[target + 1] = bytes[source + 1]!;
        pixels[target + 2] = bytes[source + (format === "bgra8unorm" ? 0 : 2)]!;
        pixels[target + 3] = bytes[source + 3]!;
      }
      return pixels;
    };
    const results: Array<{ pose: string; receiverSamples: number; referenceShadowSamples: number; differingSamples: number; discardedShadowSamples: number }> = [];
    for (const [pose, shift] of [["initial", 0.8], ["edited", -0.8], ["reset", 0.8]] as const) {
      // Exercise a native shadow permutation change as well as uniform edits.
      generator.normalBias = pose === "edited" ? 0 : 0.03;
      if (pose === "reset") authored.resetParameter("Shift");
      else authored.setParameter("Shift", { kind: "float", value: shift });
      authored.resetParameter("Cutout");
      caster.position.x = shift; caster.material = native;
      light.shadowEnabled = false;
      const lit = await render();
      light.shadowEnabled = true;
      const reference = await render();
      caster.position.x = 0; caster.material = authored.material;
      const actual = await render();
      authored.setParameter("Cutout", { kind: "float", value: 0 });
      const discarded = await render();
      const boxes: ShadowBox[] = [{ name: "caster", center: [shift, 0.8, 0], size: [1, 1, 1] }];
      const samples = shadowSurfaceSamples(camera.position.asArray() as ShadowTriple,
        Array.from(scene.getTransformMatrix().asArray()), direction.negate().asArray() as ShadowTriple,
        size, size, camera.viewport, boxes, undefined, 0.08).filter((sample) => sample.region === "ground");
      let referenceShadowSamples = 0, differingSamples = 0, discardedShadowSamples = 0;
      for (const sample of samples) {
        const offset = (sample.y * size + sample.x) * 4 + 1;
        if (lit[offset]! - reference[offset]! > 24) referenceShadowSamples++;
        if (Math.abs(actual[offset]! - reference[offset]!) > 4) differingSamples++;
        if (Math.abs(discarded[offset]! - lit[offset]!) > 4) discardedShadowSamples++;
      }
      results.push({ pose, receiverSamples: samples.length, referenceShadowSamples, differingSamples, discardedShadowSamples });
    }
    // An independent affine geometry/normal oracle exercises the deformation
    // Jacobian before normal bias, and its ordering after authored WPO.
    const restPositions = Array.from(caster.getVerticesData(VertexBuffer.PositionKind)!);
    const restNormals = Array.from(caster.getVerticesData(VertexBuffer.NormalKind)!);
    const controls: number[] = [];
    for (const z of [-2, 2]) for (const y of [-2, 2]) for (const x of [-2, 2]) {
      void z; controls.push(0.5 * x + 0.25 * y, 0, 0.2 * x);
    }
    const cage = { enabled: true, resolution: [2, 2, 2] as [number, number, number], strength: 1,
      offsets: controls, fitToMesh: false, boundsMin: [-2, -2, -2] as [number, number, number], boundsMax: [2, 2, 2] as [number, number, number] };
    const nativeCaster = new StandardMaterial("Lattice Native", scene);
    const pbrCaster = new PBRMaterial("Lattice PBR", scene);
    const mask = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    mask.hasAlpha = true;
    const maskedCaster = new StandardMaterial("Lattice Cutout", scene);
    maskedCaster.transparencyMode = Material.MATERIAL_ALPHATEST; maskedCaster.diffuseTexture = mask; maskedCaster.alphaCutOff = 0.5;
    const cases = [["native", nativeCaster, 0], ["authoredWPO", authored.material, 0.8],
      ...(kind === "directional" ? [["pbr", pbrCaster, 0], ["nativeCutout", maskedCaster, 0], ["cel", nativeCaster, 0]] as const : [])] as const;
    const latticeResults: Array<{ material: string; receiverSamples: number; referenceShadowSamples: number; differingSamples: number; discardedShadowSamples: number | null }> = [];
    let nativeCacheRestored = true;
    generator.normalBias = 0.03;
    for (const [name, surface, inputShift] of cases) {
      if (name === "cel") setSceneRenderSettings(scene, { mode: "cel" });
      authored.resetParameter("Cutout"); authored.resetParameter("Shift");
      caster.material = native; caster.position.x = 0;
      const positions = [...restPositions], normals = [...restNormals];
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]! + inputShift, y = positions[i + 1]!;
        positions[i] = 1.5 * x + 0.25 * y; positions[i + 2] = positions[i + 2]! + 0.2 * x;
        const nx = (normals[i]! - 0.2 * normals[i + 2]!) / 1.5;
        new Vector3(nx, normals[i + 1]! - 0.25 * nx, normals[i + 2]!).normalize().toArray(normals, i);
      }
      caster.setVerticesData(VertexBuffer.PositionKind, positions); caster.setVerticesData(VertexBuffer.NormalKind, normals); caster.refreshBoundingInfo();
      light.shadowEnabled = false; const lit = await render();
      light.shadowEnabled = true; const reference = await render();
      caster.setVerticesData(VertexBuffer.PositionKind, restPositions); caster.setVerticesData(VertexBuffer.NormalKind, restNormals); caster.refreshBoundingInfo();
      caster.material = surface;
      setMeshLatticeDeformer(caster, cage);
      const actual = await render();
      let discarded: Uint8Array | undefined;
      if (surface === maskedCaster) {
        mask.update(new Uint8Array([255, 255, 255, 0])); discarded = await render();
        mask.update(new Uint8Array([255, 255, 255, 255]));
      }
      const boxes: ShadowBox[] = [{ name: "affine caster", center: [1.5 * inputShift, 0.8, 0.2 * inputShift], size: [1.75, 1, 1.2] }];
      const samples = shadowSurfaceSamples(camera.position.asArray() as ShadowTriple,
        Array.from(scene.getTransformMatrix().asArray()), direction.negate().asArray() as ShadowTriple,
        size, size, camera.viewport, boxes, undefined, 0.08).filter((sample) => sample.region === "ground");
      let referenceShadowSamples = 0, differingSamples = 0, discardedShadowSamples = 0;
      for (const sample of samples) {
        const offset = (sample.y * size + sample.x) * 4 + 1;
        if (lit[offset]! - reference[offset]! > 24) referenceShadowSamples++;
        if (Math.abs(actual[offset]! - reference[offset]!) > 4) differingSamples++;
        if (discarded && Math.abs(discarded[offset]! - lit[offset]!) > 4) discardedShadowSamples++;
      }
      latticeResults.push({ material: name, receiverSamples: samples.length, referenceShadowSamples, differingSamples,
        discardedShadowSamples: discarded ? discardedShadowSamples : null });
      disposeMeshLatticeDeformer(caster);
      if (surface !== authored.material) nativeCacheRestored &&= surface.shadowDepthWrapper === null && caster.material!.shadowDepthWrapper === null;
    }
    generator.dispose();
    await disposeAuthored(); disposeAuthored = undefined;
    return { backend, kind, results, latticeResults, nativeCacheRestored, programs: [...programs.values()],
      observedShadowEffects: shadowEffects.size, shadowEffectsReleased: [...shadowEffects].every((effect) => effect.isDisposed) };
  } finally {
    await disposeAuthored?.();
    scene.dispose(); engine.dispose(); canvas.remove();
  }
}
