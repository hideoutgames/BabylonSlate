import {
  normalizeCelShadingSettings,
  normalizeShadowSettings,
  normalizeRenderingQuality,
} from "@babylonslate/core";
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
  ShaderMaterial,
  SpotLight,
  Vector3,
} from "@babylonjs/core";
import {
  applyAuthoredLightProperties,
  beginEngineDrawCallFrame,
  compileMaterialPlan,
  readEngineDrawCalls,
  setSceneRenderSettings,
  type RenderShadingSettings,
} from "@babylonslate/render";
import { createAppWebGpuEngine } from "@babylonslate/render";
import { ClusteredSceneLights } from "@babylonslate/render/clustered-scene-lights";
import { clusteredLightCapabilities } from "@babylonslate/render/clustered-light-capabilities";
import {
  readbackChannelOrder,
  toRgbaPixels,
} from "./readback-channels";
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
  const backend = new URLSearchParams(location.search).get("backend");
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
        });
  // FAST snapshot bundles replay without Light._bindLight; the proof mutates
  // light membership every frame, so run WebGPU without snapshot caching.
  if (engine.isWebGPU) engine.snapshotRendering = false;
  const captures = [];
  const ties = [];
  const lifecycle = [];
  const channelOrder = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      channelOrder,
    );
  };
  try {
    const capabilities = clusteredLightCapabilities(engine);
    if (capabilities.supported === false) throw new Error(capabilities.reason);
    for (const mixing of ["pbr", "strongest", "additive", "blend"] as const) {
      engine.setSize(96, 72);
      const mode = mixing === "pbr" ? "pbr" : "cel";
      let sameMask = true;
      let siblingBefore: number[] = [];
      let siblingAfter: number[] = [];
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
      const renderSettings: RenderShadingSettings = {
        mode,
        quality: normalizeRenderingQuality({
          lighting: { localLightMode: "manual", maxLocalLights: 48 },
        }),
        cel: normalizeCelShadingSettings({
          lightMixing: mixing === "pbr" ? "strongest" : mixing,
          lightColorInfluence: 1,
          specularEnabled: false,
        }),
      };
      setSceneRenderSettings(scene, renderSettings);
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
        applyAuthoredLightProperties(lights[index]!, {
          enabled,
          intensity,
          castShadows: false,
          range: mode === "pbr" ? 1 : 12,
          color: index % 2 ? [0.15, 0.7, 0.3] : [0.8, 0.2, 0.1],
          outerAngle: 144,
          innerAngle: 90,
        });
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
        if (count === 48) {
          const target = owner.target(camera)!;
          const texture = target.getInternalTexture();
          const alternate = new FreeCamera(
            "alternate",
            new Vector3(2, 4, -7),
            scene,
          );
          alternate.minZ = camera.minZ;
          alternate.maxZ = camera.maxZ;
          for (const mesh of scene.meshes) {
            mesh.freezeWorldMatrix();
            mesh.material?.freeze();
          }
          const poses = [
            "camera-switched",
            "camera-moved",
            "lights-moved",
            "resized",
            "after-sibling",
          ];
          const applyPose = (pose: number) => {
            scene.activeCamera = alternate;
            alternate.position.set(pose === 0 ? 2 : -2, 4, -7);
            alternate.setTarget(new Vector3(0, 0.3, 0));
            for (const [index, light] of lights.entries()) {
              light.position.copyFrom(positions[index % 2]!);
              if (pose >= 2) light.position.x += 1.5;
              if (light instanceof SpotLight)
                light.direction.copyFrom(light.position.negate().normalize());
            }
            engine.setSize(pose >= 3 ? 112 : 96, pose >= 3 ? 80 : 72);
          };
          const records: typeof captures = [];
          let sibling: Scene | undefined;
          for (let pose = 0; pose < poses.length; pose++) {
            if (pose === 4) {
              sibling = new Scene(engine);
              sibling.clearColor = new Color4(0.6, 0.2, 0.7, 1);
              sibling.activeCamera = new FreeCamera(
                "sibling",
                new Vector3(0, 0, -3),
                sibling,
              );
              sibling.render(false);
              siblingBefore = await read();
            }
            applyPose(pose);
            beginEngineDrawCallFrame(engine);
            const prepared = await graph.prepare(alternate);
            const readinessDraws = readEngineDrawCalls(engine);
            const result = graph.render(alternate, false);
            const draws = readEngineDrawCalls(engine);
            sameMask &&=
              owner.target(alternate) === target &&
              target.getInternalTexture() === texture;
            records.push({
              name: `${mixing}-${poses[pose]}`,
              count,
              reference: [],
              clustered: await read(),
              prepared,
              result,
              readinessDraws,
              draws,
              status: owner.status(),
              width: canvas.width,
              height: canvas.height,
            });
          }
          // Replay the same camera/light poses with the independent two-light
          // reference only after proving all clustered frames retained one map.
          owner.dispose();
          for (let index = 0; index < lights.length; index++)
            setLight(
              index,
              index < 2,
              perChild *
                (index ? 0.8 : 1) *
                (mixing === "pbr" || mixing === "additive" ? 24 : 1),
            );
          for (let pose = 0; pose < poses.length; pose++) {
            applyPose(pose);
            const prepared = await graph.prepare(alternate);
            if (prepared.path !== "frameGraph")
              throw new Error(prepared.reason);
            scene.render(false);
            records[pose]!.reference = await read();
          }
          captures.push(...records);
          graph.dispose();
          sibling!.render(false);
          siblingAfter = await read();
          sibling!.dispose();
        }
        owner.dispose();
      }
      graph.dispose();
      if (mixing === "strongest") {
        // Nearly coincident lights keep their contribution difference inside
        // CEL's existing tie tolerance across the receiver. A CPU center ray is
        // insufficient: raster interpolation need not hit the equality plane.
        // Camera depth still reverses their native packing order.
        for (let index = 0; index < lights.length; index++)
          setLight(index, false, 1);
        for (const mesh of scene.meshes) mesh.setEnabled(false);
        const surface = MeshBuilder.CreateGround(
          "tie receiver",
          { width: 8, height: 8 },
          scene,
        );
        const tieLights = [-0.00001, 0.00001].map((x, index) => {
          const light = new PointLight(
            `tie-${index}`,
            new Vector3(x, 3, 0),
            scene,
          );
          applyAuthoredLightProperties(light, {
            enabled: true,
            castShadows: false,
            range: 12,
            intensity: 1.2,
            color: index ? [0, 0.8, 0] : [0.8, 0, 0],
          });
          return light;
        });
        const tieGraph = new ForwardSceneFrameGraph(scene);
        const positionProbe = new ShaderMaterial(
          "numeric tie probe",
          scene,
          {
            vertexSource: `precision highp float;attribute vec3 position;uniform mat4 world;uniform mat4 viewProjection;varying vec3 probeWorld;void main(){vec4 p=world*vec4(position,1.0);probeWorld=p.xyz;gl_Position=viewProjection*p;}`,
            fragmentSource: `precision highp float;varying vec3 probeWorld;float strength(vec3 p){vec3 d=p-probeWorld;return normalize(d).y*0.96*max(0.0,1.0-length(d)/12.0);}void main(){float delta=strength(vec3(-0.00001,3.0,0.0))-strength(vec3(0.00001,3.0,0.0));gl_FragColor=vec4(probeWorld.x*1000.0+0.5,delta*10000.0+0.5,probeWorld.z*1000.0+0.5,1.0);}`,
          },
          { attributes: ["position"], uniforms: ["world", "viewProjection"] },
        );
        for (const [kind, material] of [
          ["native", native],
          ["graph", compiled.material],
        ] as const) {
          surface.material = material;
          setSceneRenderSettings(scene);
          for (const x of [-3, 3]) {
            engine.setSize(97, 73);
            scene.activeCamera = camera;
            camera.position.set(x, 3, -6);
            camera.setTarget(Vector3.Zero());
            const ready = await tieGraph.prepare(camera);
            if (ready.path !== "frameGraph") throw new Error(ready.reason);
            scene.render(false);
            const reference = await read();
            const referenceOrder = surface.lightSources.map(
              (light) => light.name,
            );
            const centerHit = scene
              .pick(canvas.width / 2, canvas.height / 2)
              ?.pickedPoint?.asArray();
            scene.render(false);
            const referenceSettled = await read();
            const effectiveMaterial = surface.material;
            const referenceDefines = surface.subMeshes[0]?.effect?.defines
              .split("\n")
              .filter((line) => /LIGHT|CEL/.test(line));
            surface.material = positionProbe;
            await tieGraph.prepare(camera);
            scene.render(false);
            const positionPixels = await read();
            const centerIndex =
              (Math.floor(canvas.height / 2) * canvas.width +
                Math.floor(canvas.width / 2)) *
              4;
            const positionProbePixel = positionPixels.slice(
              centerIndex,
              centerIndex + 4,
            );
            surface.material = effectiveMaterial;
            const owner = new ClusteredSceneLights(scene, tieLights);
            beginEngineDrawCallFrame(engine);
            const prepared = await tieGraph.prepare(camera);
            const readinessDraws = readEngineDrawCalls(engine);
            const result = tieGraph.render(camera, false);
            ties.push({
              name: `${kind}-camera-${x}`,
              reference,
              referenceSettled,
              referenceOrder,
              centerHit,
              referenceDefines,
              positionProbePixel,
              clusteredCount: owner.status().clustered,
              clustered: await read(),
              prepared,
              result,
              readinessDraws,
              width: canvas.width,
              height: canvas.height,
            });
            owner.dispose();
          }
        }
        positionProbe.dispose();
        for (const light of tieLights) light.dispose();
        // Epsilon comparison is sequential: each small increase is a tie, while
        // reducing the last two lights first would spuriously replace the red
        // conventional prefix. The point map is real, with an unoccluded floor.
        setSceneRenderSettings(scene, {
          ...renderSettings,
          shadows: normalizeShadowSettings({
            localLightMode: "manual",
            maxLocalLights: 1,
            localMapSize: 256,
            mapSize: 256,
            autoBias: false,
            normalBias: 0.02,
            depthBias: 0.001,
          }),
        });
        const mixedLights = [0, 1, 2].map((index) => {
          const light = new PointLight(
            `mixed-${index}`,
            new Vector3(0, 3, 0),
            scene,
          );
          applyAuthoredLightProperties(light, {
            enabled: true,
            castShadows: index === 0,
            range: 12,
            intensity: 1.2 + index * 0.000014,
            color:
              index === 0
                ? [0.8, 0, 0]
                : index === 1
                  ? [0, 0.8, 0]
                  : [0, 0, 0.8],
          });
          return light;
        });
        for (const [kind, material] of [
          ["native", native],
          ["graph", compiled.material],
        ] as const) {
          surface.material = material;
          setSceneRenderSettings(scene);
          for (const x of [-3, 3]) {
            engine.setSize(97, 73);
            scene.activeCamera = camera;
            camera.position.set(x, 3, -6);
            camera.setTarget(Vector3.Zero());
            const ready = await tieGraph.prepare(camera);
            if (ready.path !== "frameGraph") throw new Error(ready.reason);
            scene.render(false);
            const reference = await read();
            const referenceOrder = surface.lightSources.map(
              (light) => light.name,
            );
            const owner = new ClusteredSceneLights(scene, mixedLights);
            beginEngineDrawCallFrame(engine);
            const prepared = await tieGraph.prepare(camera);
            const readinessDraws = readEngineDrawCalls(engine);
            const result = tieGraph.render(camera, false);
            ties.push({
              name: `${kind}-mixed-camera-${x}`,
              reference,
              referenceOrder,
              positionProbePixel: null,
              clusteredCount: owner.status().clustered,
              clustered: await read(),
              prepared,
              result,
              readinessDraws,
              width: canvas.width,
              height: canvas.height,
            });
            owner.dispose();
          }
        }
        for (const light of mixedLights) light.dispose();
        tieGraph.dispose();
        surface.dispose();
      }
      lifecycle.push({
        mixing,
        sameMask,
        siblingBefore,
        siblingAfter,
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
    return { capabilities, captures, ties, lifecycle, graphics: {
      requestedApi: backend ?? "webgl2", effectiveApi: engine.isWebGPU ? "webgpu" : "webgl2",
      adapter: engine.getGlInfo(), browser: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      drawingBuffer: { width: engine.getRenderWidth(), height: engine.getRenderHeight() },
      devicePixelRatio,
    } };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
