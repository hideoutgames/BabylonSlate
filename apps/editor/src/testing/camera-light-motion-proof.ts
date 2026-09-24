/** Camera-motion oracle against an absolute-coordinate scene on the same GPU. */
import {
  Color3, Color4, DirectionalLight, Engine, MeshBuilder, PBRMaterial, PointLight,
  Scene, SpotLight, Vector3, WebGPUEngine,
} from "@babylonjs/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createEditorCamera, setSceneRenderSettings } from "@babylonslate/render";
import { normalizeCelShadingSettings, normalizeEnvironmentLightingSettings, normalizeShadowSettings } from "@babylonslate/core";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { freezeEditorActiveMeshes } from "@babylonslate/render/scene-perf";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";

export async function runCameraLightMotionProof(backend: "webgl2" | "webgpu", shadows = false, frozen = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  // Scene-level floating origin lets the reference use absolute coordinates.
  const engine = backend === "webgpu"
    ? new WebGPUEngine(canvas, { antialias: false, useHighPrecisionMatrix: true })
    : new Engine(canvas, false, { preserveDrawingBuffer: true, useHighPrecisionMatrix: true });
  const captures = [];
  try {
    if (engine instanceof WebGPUEngine) await engine.initAsync();
    for (const mode of ["pbr", "cel"] as const) {
      for (const kind of shadows ? ["point", "spot", "sun"] as const : ["point", "spot"] as const) {
        const makeScene = async (floating: boolean) => {
          const scene = new Scene(engine, { useFloatingOrigin: floating });
          scene.clearColor = new Color4(0, 0, 0, 1);
          const controller = createEditorCamera(scene);
          const camera = controller.camera;
          camera.alpha = -Math.PI / 2;
          camera.beta = Math.PI / 2;
          camera.radius = 6;
          camera.minZ = 0.1;
          camera.maxZ = 50;
          const position = new Vector3(0.7, 0.4, -2);
          const light = kind === "point"
            ? new PointLight("stationary", position, scene)
            : kind === "spot"
              ? new SpotLight("stationary", position, new Vector3(-0.1, -0.1, 1).normalize(), Math.PI / 2, 1, scene)
              : new DirectionalLight("stationary", new Vector3(-0.6, -0.4, 1).normalize(), scene);
          light.position.copyFromFloats(0.7, 0.4, -2);
          light.range = 6;
          light.intensity = mode === "cel" ? 0.8 : kind === "sun" ? 1 : 8;
          if (shadows) applyAuthoredLightProperties(light, { castShadows: true, intensity: light.intensity, range: 6, outerAngle: 90, innerAngle: 60 });
          light.specular = Color3.Black();
          light.diffuse = new Color3(1, 0.6, 0.3);
          const native = new PBRMaterial("native", scene);
          native.albedoColor = new Color3(0.65, 0.65, 0.65);
          native.metallic = 0;
          native.roughness = 1;
          setSceneRenderSettings(scene, { mode, cel: normalizeCelShadingSettings({ specularEnabled: false, outlinesEnabled: false }),
            environmentLighting: normalizeEnvironmentLightingSettings({ enabled: false }),
            shadows: normalizeShadowSettings({ cascades: 2, mapSize: 256, localMapSize: 256, maxLocalLights: 1, autoBias: false, normalBias: 0.01, depthBias: 0.0001, distance: 15 }) });
          const document = createDefaultMaterialDocument("stationary graph");
          const lowered = lowerMaterialDocument(document);
          if (!lowered.ok) throw new Error("Light-motion material did not lower");
          const compiled = compileMaterialPlan(lowered.plan, { scene, name: "stationary graph" });
          if (!compiled.ok) throw new Error("Light-motion material did not compile");
          if ((await compiled.ready).some((entry) => entry.severity === "error")) throw new Error("Light-motion shader failed");
          for (const [x, material] of [[-1.4, native], [1.4, compiled.material]] as const) {
            const receiver = MeshBuilder.CreatePlane(`receiver ${x}`, { width: 2.6, height: 3.2 }, scene);
            receiver.position.x = x;
            receiver.material = material;
            receiver.freezeWorldMatrix();
            if (shadows) {
              const caster = MeshBuilder.CreateBox(`caster ${x}`, { size: 0.55 }, scene);
              caster.position.set(x, 0, -0.65);
              caster.material = material;
              caster.freezeWorldMatrix();
            }
          }
          setSceneRenderSettings(scene);
          await scene.whenReadyAsync();
          for (const mesh of scene.meshes) mesh.material?.freeze();
          // Prepare both camera and object passes, including shadow variants,
          // before comparing the first submitted frame at each camera pose.
          const graph = new ForwardSceneFrameGraph(scene);
          if ((await graph.prepare(camera)).path !== "frameGraph") throw new Error("Light-motion graph was not ready");
          if (frozen) freezeEditorActiveMeshes(scene);
          return { scene, controller, camera, light, graph, floating };
        };
        const reference = await makeScene(false);
        const subject = await makeScene(true);
        const draw = async (host: typeof subject) => {
          engine.beginFrame();
          try {
            if (host.floating && !frozen) {
              const result = host.graph.render(host.camera);
              if (result.path !== "frameGraph") throw new Error(`Light-motion graph fell back: ${result.reason}`);
            } else host.scene.render();
          } finally { engine.endFrame(); }
          const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
          return Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
        };
        try {
          // Finish the independent classic pass and editor freeze before measuring.
          await reference.scene.whenReadyAsync(true);
          await draw(reference);
          await draw(subject);
          for (const motion of ["initial", "strafe", "forward", "look", "orbit", "zoom"] as const) {
            for (const host of [reference, subject]) {
              if (motion === "strafe") host.controller.fly(0, 0.25);
              if (motion === "forward") host.controller.fly(0.3, 0);
              if (motion === "look") host.controller.look(0.03, -0.04);
              if (motion === "orbit") host.controller.orbit(0.04, 0.01);
              if (motion === "zoom") host.controller.zoom(1.1);
            }
            const expected = await draw(reference);
            const first = await draw(subject);
            const settled = await draw(subject);
            captures.push({ mode, kind, motion,
              difference: Math.max(...first.map((value, index) => Math.abs(value - expected[index]!))),
              settledDifference: Math.max(...first.map((value, index) => Math.abs(value - settled[index]!))),
              litPixels: expected.filter((value, index) => index % 4 !== 3 && value > 30).length,
              lightPosition: subject.light.position.asArray(),
              activeMeshesFrozen: subject.scene._activeMeshesFrozen,
              mismatchSamples: first.flatMap((value, index) => index % 4 === 0 && Math.abs(value - expected[index]!) > 2
                ? [{ x: index / 4 % canvas.width, y: Math.floor(index / 4 / canvas.width), expected: expected.slice(index, index + 3), actual: first.slice(index, index + 3) }] : []).slice(0, 5),
            });
          }
        } finally {
          subject.graph.dispose();
          reference.graph.dispose();
          subject.scene.dispose();
          reference.scene.dispose();
        }
      }
    }
    return { backend, shadows, frozen, captures };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
