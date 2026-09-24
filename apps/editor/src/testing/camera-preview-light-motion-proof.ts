/** A stationary authored camera preview must ignore editor camera navigation. */
import {
  Color3, Color4, Engine, MeshBuilder, PBRMaterial, PointLight, Scene,
  SpotLight, UtilityLayerRenderer, Vector3,
} from "@babylonjs/core";
import {
  compileMaterialPlan, createAppWebGpuEngine, createEditorCamera,
  EditorDebugOverlay, setSceneRenderSettings,
} from "@babylonslate/render";
import {
  createActor, createDefaultScene, identitySerializedTransform,
  normalizeCelShadingSettings, normalizeEnvironmentLightingSettings,
} from "@babylonslate/core";
import { withSceneReadinessState } from "@babylonslate/render/scene-perf";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";

export async function runCameraPreviewLightMotionProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, useLargeWorldRendering: true });
  const captures = [];
  try {
    for (const mode of ["pbr", "cel"] as const) {
      for (const kind of ["point", "spot"] as const) {
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0, 0, 0, 1);
        const controller = createEditorCamera(scene);
        // The editor draws gizmos after its world pass, leaving Babylon's
        // floating-origin context on the utility scene before the timer fires.
        const utility = new UtilityLayerRenderer(scene, false, true);
        utility.setRenderCamera(controller.camera);
        controller.camera.alpha = -Math.PI / 2;
        controller.camera.beta = Math.PI / 2;
        controller.camera.radius = 6;
        const position = new Vector3(0.7, 0.4, -2);
        const light = kind === "point"
          ? new PointLight("stationary", position, scene)
          : new SpotLight("stationary", position, new Vector3(-0.1, -0.1, 1).normalize(), Math.PI / 2, 1, scene);
        light.range = 6;
        light.intensity = mode === "cel" ? 0.8 : 8;
        light.specular = Color3.Black();
        light.diffuse = new Color3(1, 0.6, 0.3);
        const native = new PBRMaterial("native", scene);
        native.albedoColor = new Color3(0.65, 0.65, 0.65);
        native.metallic = 0;
        native.roughness = 1;
        setSceneRenderSettings(scene, {
          mode,
          cel: normalizeCelShadingSettings({ specularEnabled: false, outlinesEnabled: false }),
          environmentLighting: normalizeEnvironmentLightingSettings({ enabled: false }),
        });
        const lowered = lowerMaterialDocument(createDefaultMaterialDocument("preview receiver"));
        if (!lowered.ok) throw new Error("Preview material did not lower");
        const compiled = compileMaterialPlan(lowered.plan, { scene, name: "preview receiver" });
        if (!compiled.ok || (await compiled.ready).some((entry) => entry.severity === "error")) throw new Error("Preview material did not compile");
        for (const [x, material] of [[-1.4, native], [1.4, compiled.material]] as const) {
          const receiver = MeshBuilder.CreatePlane(`receiver ${x}`, { width: 2.6, height: 3.2 }, scene);
          receiver.position.x = x;
          receiver.material = material;
          receiver.freezeWorldMatrix();
        }
        setSceneRenderSettings(scene);
        let now = 0;
        const overlay = new EditorDebugOverlay(scene, { now: () => now });
        const sceneData = createDefaultScene();
        sceneData.actors = [createActor("camera", "Stationary Camera", {
          transform: { ...identitySerializedTransform(), position: [0, 0, -6] },
          components: [{ id: "camera", classId: "CameraComponent", properties: { fieldOfView: 60, nearClip: 0.1, farClip: 50 } }],
        })];
        try {
          // Selection follows an already presented editor frame.
          const sceneDeadline = performance.now() + 10_000;
          while (!withSceneReadinessState(scene, () => scene.isReady(true))) {
            if (performance.now() > sceneDeadline) throw new Error("Editor scene did not become ready");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
          }
          engine.beginFrame();
          try { scene.render(); utility.render(); }
          finally { engine.endFrame(); }
          overlay.sync({ sceneData, selectedActorIds: ["camera"] });
          const target = overlay.previewTexture!;
          const deadline = performance.now() + 10_000;
          while (!withSceneReadinessState(scene, () => target.isReadyForRendering())) {
            if (performance.now() > deadline) throw new Error("Camera preview did not become ready");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
          }
          for (const mesh of scene.meshes) mesh.material?.freeze();
          const draw = async () => {
            engine.beginFrame();
            try {
              scene.render();
              utility.render();
              now += 1000;
              overlay.tick();
            } finally { engine.endFrame(); }
            const pixels = await target.readPixels();
            if (!pixels) throw new Error("Camera preview returned no pixels");
            return Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          };
          await draw();
          const baseline = await draw();
          for (const motion of ["strafe", "forward", "look", "orbit", "zoom"] as const) {
            if (motion === "strafe") controller.fly(0, 0.25);
            if (motion === "forward") controller.fly(0.3, 0);
            if (motion === "look") controller.look(0.03, -0.04);
            if (motion === "orbit") {
              controller.setPivotAroundCenter(true);
              controller.orbit(0.04, 0.01);
            }
            if (motion === "zoom") controller.zoom(1.1);
            const pixels = await draw();
            let difference = 0;
            for (let i = 0; i < pixels.length; i++) difference = Math.max(difference, Math.abs(pixels[i]! - baseline[i]!));
            captures.push({ mode, kind, motion, difference,
              litPixels: pixels.filter((value, index) => index % 4 !== 3 && value > 30).length,
              lightPosition: light.position.asArray(),
            });
          }
          // A stable but unlit/blank preview must not satisfy the motion test.
          light.position.x += 2;
          const movedLight = await draw();
          const lightResponse = [0, 0];
          for (let i = 0; i < movedLight.length; i++) {
            if (i % 4 === 3) continue;
            const half = Math.floor(i / 4) % target.getSize().width < target.getSize().width / 2 ? 0 : 1;
            lightResponse[half] = Math.max(lightResponse[half]!, Math.abs(movedLight[i]! - baseline[i]!));
          }
          captures.push({ mode, kind, motion: "light moved", difference: Math.min(...lightResponse),
            litPixels: movedLight.filter((value, index) => index % 4 !== 3 && value > 30).length,
            lightPosition: light.position.asArray(),
          });
        } finally {
          overlay.dispose();
          utility.dispose();
          scene.dispose();
        }
      }
    }
    return { backend, captures };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
