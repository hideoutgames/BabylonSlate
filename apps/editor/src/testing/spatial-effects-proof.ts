import {
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
} from "@babylonjs/core";
import {
  normalizeRenderEffectsSettings,
  normalizeShadowSettings,
} from "@babylonslate/core";
import {
  applyAuthoredLightProperties,
  createAppWebGpuEngine,
  MaterialLibrary,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

function normalIdentityDocument() {
  const document = createDefaultMaterialDocument("Normals Identity", "postProcess");
  // World normals are stored as n * 0.5 + 0.5. Decode before length so a unit
  // normal keeps scene color while the sample still keeps the prepass alive.
  for (const [id, type, properties] of [
    ["normal", "input.sceneNormal", {}],
    ["two", "const.vec3", { value: [2, 2, 2] }],
    ["one", "const.vec3", { value: [1, 1, 1] }],
    ["scaled", "math.multiply", {}],
    ["decoded", "math.subtract", {}],
    ["length", "vector.length", {}],
    ["multiply", "math.multiply", {}],
  ] as const)
    document.nodes.push({ id, type, position: { x: 0, y: 0 }, properties: { ...properties } });
  document.edges = document.edges.filter((edge) => edge.id !== "e-scene-output");
  for (const [from, output, to, input] of [
    ["screenUv", "uv", "normal", "uv"],
    ["normal", "normal", "scaled", "a"],
    ["two", "out", "scaled", "b"],
    ["scaled", "out", "decoded", "a"],
    ["one", "out", "decoded", "b"],
    ["decoded", "out", "length", "value"],
    ["length", "out", "multiply", "b"],
    ["sceneColor", "color", "multiply", "a"],
    ["multiply", "out", "output", "color"],
  ])
    document.edges.push({
      id: `${from}-${to}`,
      sourceNodeId: from,
      sourcePinId: output,
      targetNodeId: to,
      targetPinId: input,
    });
  return document;
}

/** Actual numeric pixels from authored materials and scene lights, without editor chrome. */
export async function runSpatialEffectsProof(
  backend: "webgl2" | "webgpu",
  kind: "reflections" | "point" | "spot" | "sun" | "combined",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
        });
  engine.setSize(96, 72);
  const captures = [];
  try {
    for (const path of ["frameGraph", "classic"] as const) {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const library = new MaterialLibrary();
      const camera = new FreeCamera(
        "Spatial Camera",
        new Vector3(0, 2.5, -6),
        scene,
      );
      camera.minZ = 0.1;
      camera.maxZ = 30;
      camera.setTarget(new Vector3(0, 0.6, 0));
      scene.activeCamera = camera;
      if (path === "classic") scene.activeCameras = [camera];
      const black = new PBRMaterial("Neutral Occluders", scene);
      black.unlit = true;
      black.albedoColor = new Color3(0.08, 0.08, 0.08);
      const floor = MeshBuilder.CreateGround(
        "Floor",
        { width: 20, height: 20 },
        scene,
      );
      floor.material = black;
      let light: DirectionalLight | SpotLight | PointLight | undefined;
      if (kind === "reflections" || kind === "combined") {
        const document = createDefaultMaterialDocument("Authored Mirror");
        document.nodes.find(
          (node) => node.id === "baseColor",
        )!.properties.value = [0.9, 0.9, 0.9];
        Object.assign(
          document.nodes.find((node) => node.id === "output")!.properties,
          { "default:metallic": [1], "default:roughness": [0.05] },
        );
        const compiled = library.acquire(scene, "mirror", document);
        if (
          !compiled.ok ||
          (await compiled.ready).some((d) => d.severity === "error")
        )
          throw new Error("Mirror compilation failed");
        floor.material = compiled.material;
        const red = new PBRMaterial("Red Reflection Subject", scene);
        red.unlit = true;
        red.albedoColor = new Color3(0.6, 0, 0);
        const box = MeshBuilder.CreateBox(
          "Reflection Subject",
          { size: 1.5 },
          scene,
        );
        box.position.y = 1.3;
        box.material = red;
      }
      if (kind !== "reflections") {
        const position = new Vector3(0, 3, 0);
        light =
          kind === "point"
            ? new PointLight("Fog Light", position, scene)
            : kind === "spot" || kind === "combined"
              ? new SpotLight(
                  "Fog Light",
                  position,
                  Vector3.Down(),
                  Math.PI / 2,
                  1,
                  scene,
                )
              : new DirectionalLight(
                  "Fog Light",
                  new Vector3(0.2, -1, 0.1),
                  scene,
                );
        applyAuthoredLightProperties(light, {
          intensity: kind === "sun" ? 5 : 20,
          range: 12,
          outerAngle: 90,
          innerAngle: 60,
          castShadows: true,
        });
        const blocker = MeshBuilder.CreateBox(
          "Beam Occluder",
          { width: 2, height: 0.2, depth: 2 },
          scene,
        );
        blocker.position.y = 1.5;
        blocker.material = black;
      }
      const effects = normalizeRenderEffectsSettings({
        reflections: { enabled: false, maxSteps: 96, thickness: 0.3 },
        volumetricLighting: {
          enabled: false,
          steps: 32,
          density: 0.12,
          maxDistance: 12,
          intensity: 2,
          anisotropy: 0,
        },
      });
      const settings = () =>
        setSceneRenderSettings(scene, {
          mode: "pbr",
          effects,
          shadows: normalizeShadowSettings({
            mapSize: 256,
            localMapSize: 256,
            cascades: 2,
            maxLocalLights: 1,
            distance: 20,
          }),
        });
      settings();
      const graph = new ForwardSceneFrameGraph(scene);
      const draw = async (activeCamera = camera) => {
        scene.activeCamera = activeCamera;
        if (path === "classic") scene.activeCameras = [activeCamera];
        settings();
        const prepared = await graph.prepare(activeCamera);
        if (prepared.path !== path)
          throw new Error(`Expected ${path}: ${JSON.stringify(prepared)}`);
        const deadline = performance.now() + 15_000;
        while (!graph.readiness(activeCamera).ready) {
          if (performance.now() > deadline)
            throw new Error("Spatial readiness timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
        // Warm the native prepass and updated shadow map before readback.
        for (let presented = 0; presented < 2;) {
          engine.beginFrame();
          let rendered = false;
          try {
            const result = graph.render(activeCamera, false);
            rendered = result.rendered !== false;
          } finally {
            engine.endFrame();
          }
          if (rendered) presented++;
          else {
            if (performance.now() > deadline)
              throw new Error("Spatial presentation timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            await graph.prepare(activeCamera);
          }
        }
        const pixels = await engine.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const result = Array.from(
          new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        );
        if (
          backend === "webgpu" &&
          (
            navigator as Navigator & {
              gpu: { getPreferredCanvasFormat(): string };
            }
          ).gpu.getPreferredCanvasFormat() === "bgra8unorm"
        )
          for (let i = 0; i < result.length; i += 4)
            [result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
        return result;
      };
      try {
        const off = await draw();
        effects.reflections.enabled =
          kind === "reflections" || kind === "combined";
        effects.volumetricLighting.enabled = kind !== "reflections";
        const on = await draw();
        const stackDifferences: number[] = [];
        if (kind === "reflections") {
          const document = normalIdentityDocument();
          const attach = () => graph.attachPostProcess({ scene, camera, library,
            stack: [{ materialGuid: "normal-identity", enabled: true, order: 0 }], documentFor: () => document,
          }, () => {});
          let stack = attach();
          // A normal-consuming authored pass keeps the prepass alive while
          // spatial requirements change from fog depth to reflection buffers.
          effects.reflections.enabled = false;
          effects.volumetricLighting.enabled = true;
          effects.volumetricLighting.density = 0;
          await draw();
          effects.reflections.enabled = true;
          effects.volumetricLighting.enabled = false;
          const checkStack = async () => {
            const pixels = await draw();
            stackDifferences.push(pixels.reduce((sum, value, i) => sum + Math.abs(value - on[i]!), 0) / on.length);
            if (path === "classic") {
              const passes = camera._postProcesses.filter((pass) => pass !== null);
              if (passes.indexOf(stack.passes[0]!) > passes.findIndex((pass) => pass.name === "Scene Reflections"))
                throw new Error("Authored color must precede scene reflections");
            }
          };
          await checkStack();
          stack = attach();
          await checkStack();
          stack.dispose();
          const restored = await draw();
          stackDifferences.push(restored.reduce((sum, value, i) => sum + Math.abs(value - on[i]!), 0) / on.length);
        }
        effects.vignette.enabled = true;
        effects.vignette.weight = 0;
        const identityDisplay = await draw();
        effects.vignette.enabled = false;
        effects.colorPipeline.mode = "sceneLinear";
        const linear = await draw();
        effects.colorPipeline.mode = "legacyDisplay";
        let changed: number[];
        let cameraSwitchDifference = 0;
        if (light) {
          applyAuthoredLightProperties(light, {
            intensity: kind === "sun" ? 5 : 20,
            range: 12,
            outerAngle: 90,
            innerAngle: 60,
            castShadows: false,
          });
          changed = await draw();
          applyAuthoredLightProperties(light, {
            intensity: kind === "sun" ? 5 : 20,
            range: 12,
            outerAngle: 90,
            innerAngle: 60,
            castShadows: true,
          });
        } else {
          camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
          camera.orthoLeft = -4;
          camera.orthoRight = 4;
          camera.orthoTop = 3;
          camera.orthoBottom = -3;
          changed = await draw();
          const alternate = new FreeCamera(
            "Alternate Spatial Camera",
            new Vector3(1, 2.5, -6),
            scene,
          );
          alternate.minZ = camera.minZ;
          alternate.maxZ = camera.maxZ;
          alternate.mode = Camera.ORTHOGRAPHIC_CAMERA;
          alternate.orthoLeft = -4;
          alternate.orthoRight = 4;
          alternate.orthoTop = 3;
          alternate.orthoBottom = -3;
          alternate.setTarget(new Vector3(0, 0.6, 0));
          const switched = await draw(alternate);
          camera.position.copyFrom(alternate.position);
          camera.setTarget(new Vector3(0, 0.6, 0));
          const samePose = await draw();
          cameraSwitchDifference =
            switched.reduce(
              (sum, value, i) => sum + Math.abs(value - samePose[i]!),
              0,
            ) / switched.length;
          alternate.dispose();
          camera.position.set(0, 2.5, -6);
          camera.setTarget(new Vector3(0, 0.6, 0));
          camera.mode = Camera.PERSPECTIVE_CAMERA;
        }
        effects.reflections.enabled =
          effects.volumetricLighting.enabled = false;
        const disabled = await draw();
        captures.push({
          path,
          off,
          on,
          identityDisplay,
          linear,
          changed,
          disabled,
          cameraSwitchDifference,
          stackDifferences,
        });
      } finally {
        graph.dispose();
        await graph.whenReleased();
        library.dispose();
        scene.dispose();
        // This fixture owns the entire engine. Drain queued WebGPU destruction
        // after CPU teardown, just as the host's next frame or Engine.dispose does.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        engine.beginFrame();
        engine.endFrame();
      }
    }
    return { captures, reservations: managedRenderReservations(engine) };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
