import { normalizeCelShadingSettings } from "@babylonslate/core";
/** Real GPU contribution oracle; this hook is available only in test builds. */
import {
  Color3,
  Color4,
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
  applyAuthoredLightProperties,
  beginEngineDrawCallFrame,
  compileMaterialPlan,
  readEngineDrawCalls,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ClusteredSceneLights } from "@babylonslate/render/clustered-scene-lights";
import { clusteredLightCapabilities } from "@babylonslate/render/clustered-light-capabilities";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runClusteredLightProof() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const captures = [];
  const lifecycle = [];
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return Array.from(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
  };
  try {
    const capabilities = clusteredLightCapabilities(engine);
    if (capabilities.supported === false) throw new Error(capabilities.reason);
    for (const mixing of ["pbr", "strongest", "additive", "blend"] as const) {
      const mode = mixing === "pbr" ? "pbr" : "cel";
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0.01, 0.02, 0.04, 1);
      const camera = new FreeCamera("camera", new Vector3(0, 4, -7), scene);
      camera.setTarget(new Vector3(0, 0.3, 0));
      camera.minZ = 0.1;
      camera.maxZ = 30;
      scene.activeCamera = camera;
      const native = new PBRMaterial("native", scene);
      native.albedoColor = new Color3(0.8, 0.8, 0.8);
      native.metallic = 0;
      native.roughness = 1;
      setSceneRenderSettings(scene, {
        mode,
        cel: normalizeCelShadingSettings({
          lightMixing: mixing === "pbr" ? "strongest" : mixing,
          lightColorInfluence: 1,
          specularEnabled: false,
        }),
      });
      const document = createDefaultMaterialDocument("graph");
      document.nodes.find((node) => node.id === "baseColor")!.properties.value =
        [0.8, 0.8, 0.8];
      const lower = lowerMaterialDocument(document);
      if (!lower.ok) throw new Error("Clustered surface did not lower");
      const compiled = compileMaterialPlan(lower.plan, {
        scene,
        name: "graph",
      });
      if (
        !compiled.ok ||
        (await compiled.ready).some(
          (diagnostic) => diagnostic.severity === "error",
        )
      )
        throw new Error("Clustered surface did not compile");
      for (const [index, material] of [native, compiled.material].entries()) {
        const floor = MeshBuilder.CreateGround(
          `receiver-${index}`,
          { width: 3, height: 5 },
          scene,
        );
        floor.position.x = index ? 1.5 : -1.5;
        floor.material = material;
        const box = MeshBuilder.CreateBox(`box-${index}`, { size: 0.9 }, scene);
        box.position.set(index ? 1.2 : -1.2, 0.45, 0);
        box.material = material;
      }
      setSceneRenderSettings(scene);
      const positions = [new Vector3(-2, 3, -1), new Vector3(2, 4, 1)];
      const lights = Array.from({ length: 48 }, (_, index) => {
        const group = index % 2;
        const position = positions[group]!;
        const light =
          group === 0
            ? new PointLight(`point-${index}`, position.clone(), scene)
            : new SpotLight(
                `spot-${index}`,
                position.clone(),
                position.negate().normalize(),
                Math.PI * 0.8,
                1,
                scene,
              );
        applyAuthoredLightProperties(light, {
          enabled: false,
          castShadows: false,
          range: mode === "pbr" ? 1 : 12,
          color: group ? [0.15, 0.7, 0.3] : [0.8, 0.2, 0.1],
          outerAngle: 144,
          innerAngle: 90,
        });
        return light;
      });
      const graph = new ForwardSceneFrameGraph(scene);
      const setLight = (index: number, enabled: boolean, intensity: number) =>
        applyAuthoredLightProperties(lights[index]!, { enabled, intensity });
      for (const count of [1, 2, 24, 48]) {
        const groups = Math.min(count, 2);
        const perChild =
          mixing === "pbr" ? 0.6 : mixing === "additive" ? 0.07 : 0.8;
        // Exact replicas give an independent conventional oracle within two
        // UBO slots. Additive physical light scales with replica count; peak-
        // based CEL policies retain the original per-child intensity.
        for (let index = 0; index < lights.length; index++)
          setLight(
            index,
            index < groups,
            perChild *
              (index ? 0.8 : 1) *
              (mixing === "pbr" || mixing === "additive" ? count / groups : 1),
          );
        const referenceReady = await graph.prepare(camera);
        if (referenceReady.path !== "frameGraph")
          throw new Error(referenceReady.reason);
        scene.render(false);
        const reference = await read();
        for (let index = 0; index < lights.length; index++)
          setLight(index, index < count, perChild * (index % 2 ? 0.8 : 1));
        const owner = new ClusteredSceneLights(scene, lights);
        beginEngineDrawCallFrame(engine);
        const prepared = await graph.prepare(camera);
        const readinessDraws = readEngineDrawCalls(engine);
        const result = graph.render(camera, false);
        const draws = readEngineDrawCalls(engine);
        const clustered = await read();
        captures.push({
          name: `${mixing}-${count}`,
          count,
          reference,
          clustered,
          prepared,
          result,
          readinessDraws,
          draws,
          status: owner.status(),
          width: canvas.width,
          height: canvas.height,
        });
        owner.dispose();
      }
      graph.dispose();
      lifecycle.push({
        mixing,
        liveLights: lights.filter((light) => !light.isDisposed()).length,
        clusteredTextures: scene.textures.filter(
          (texture) =>
            texture.name.includes("clustered") ||
            texture.name === "TileMaskTexture",
        ).length,
        renderers: scene.objectRenderers.length,
      });
      scene.dispose();
    }
    return { capabilities, captures, lifecycle };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
