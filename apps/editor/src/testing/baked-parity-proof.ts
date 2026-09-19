/** Test-build-only shading oracle: analytic physical-E atlas vs realtime point light. */
import {
  Color3,
  Color4,
  Constants,
  DirectionalLight,
  FreeCamera,
  Light,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  Vector3,
  type AbstractEngine,
  type BaseTexture,
} from "@babylonjs/core";
import { createAppEngine, createAppWebGpuEngine } from "@babylonslate/render";
import {
  analyticDirectionalIrradiance,
  analyticPointIrradiance,
} from "../../../../packages/render/src/baked-irradiance";
import { BakedIrradiancePlugin } from "../../../../packages/render/src/baked-irradiance-plugin";
import { CelMaterial } from "../../../../packages/render/src/cel-material";

const SIZE = 96;
const ATLAS = 64;
const PLANE = 4;
const LIGHT_INTENSITY = 4;
const DIR_INTENSITY = 1;

/** Plane lives in XY at z=0; camera and lamp sit on its authored normal side. */
function receiver(scene: Scene, normal: readonly [number, number, number]) {
  const mesh = MeshBuilder.CreatePlane("Receiver", { size: PLANE }, scene);
  const positions = mesh.getVerticesData("position")!;
  const uv2: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    uv2.push(
      (positions[vertex * 3]! + PLANE / 2) / PLANE,
      (positions[vertex * 3 + 1]! + PLANE / 2) / PLANE,
    );
  }
  mesh.setVerticesData("uv2", uv2);
  const camera = new FreeCamera(
    "Camera",
    new Vector3(normal[0] * 5.5, normal[1] * 5.5, normal[2] * 5.5),
    scene,
  );
  camera.setTarget(Vector3.Zero());
  return { mesh, camera };
}

/** rgba32float atlas: texel (i,j) holds the analytic E at the surface point mapping to its center. */
function analyticAtlas(
  scene: Scene,
  irradiance: (point: [number, number, number]) => [number, number, number],
): BaseTexture {
  const bytes = new Uint8Array(ATLAS * ATLAS * 16);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < ATLAS; y++)
    for (let x = 0; x < ATLAS; x++) {
      const e = irradiance([
        -PLANE / 2 + (PLANE * (x + 0.5)) / ATLAS,
        -PLANE / 2 + (PLANE * (y + 0.5)) / ATLAS,
        0,
      ]);
      const offset = (y * ATLAS + x) * 16;
      view.setFloat32(offset, e[0], true);
      view.setFloat32(offset + 4, e[1], true);
      view.setFloat32(offset + 8, e[2], true);
      view.setFloat32(offset + 12, 1, true);
    }
  const texture = new RawTexture(
    bytes,
    ATLAS,
    ATLAS,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Constants.TEXTURE_CLAMP_ADDRESSMODE,
    Constants.TEXTURETYPE_FLOAT,
  );
  texture.updateSamplingMode(Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  return texture;
}

function pbr(name: string, scene: Scene): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = new Color3(0.5, 0.5, 0.5);
  material.metallic = 0;
  material.roughness = 1;
  // Pin the diffuse model to normalized Lambert so realtime diffuse is
  // exactly `lightColor * cos * attenuation / PI` — the same quantity the
  // baked term adds to diffuseBase. The default EON model deviates from
  // Lambert at nonzero roughness, which is fine shading but not a fixed
  // analytic oracle.
  material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
  return material;
}

function cel(name: string, scene: Scene): CelMaterial {
  const material = new CelMaterial(pbr(name, scene), scene);
  material.diffuseColor = new Color3(0.5, 0.5, 0.5);
  return material;
}

async function row(
  engine: AbstractEngine,
  scene: Scene,
): Promise<number[][]> {
  await scene.whenReadyAsync();
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  const pixels = await engine.readPixels(0, 0, SIZE, SIZE);
  const data = new Uint8Array(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength,
  );
  const bgra =
    engine.isWebGPU &&
    navigator.gpu.getPreferredCanvasFormat() === "bgra8unorm";
  const y = engine.isWebGPU ? SIZE - 1 - SIZE / 2 : SIZE / 2;
  const result: number[][] = [];
  for (let x = 16; x < SIZE - 16; x++) {
    const value = Array.from(data.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));
    result.push(bgra ? [value[2]!, value[1]!, value[0]!, value[3]!] : value);
  }
  return result;
}

export async function runBakedParityProof() {
  const result = [];
  for (const backend of ["webgl2", "webgpu"] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    document.getElementById("root")!.append(canvas);
    const engine =
      backend === "webgpu"
        ? await createAppWebGpuEngine(canvas)
        : createAppEngine(canvas);
    const scene = new Scene(engine);
    try {
      scene.clearColor = new Color4(0, 0, 0, 1);
      scene.ambientColor = new Color3(0, 0, 0);
      const authored = MeshBuilder.CreatePlane("Probe", { size: 1 }, scene);
      const normal = authored
        .getVerticesData("normal")!
        .slice(0, 3) as unknown as [number, number, number];
      authored.dispose();
      const { mesh } = receiver(scene, normal);
      const lightPosition: [number, number, number] = [
        normal[0] * 2,
        normal[1] * 2,
        normal[2] * 2,
      ];
      const pointLight = new PointLight(
        "Lamp",
        new Vector3(...lightPosition),
        scene,
      );
      pointLight.intensity = LIGHT_INTENSITY;
      pointLight.falloffType = Light.FALLOFF_PHYSICAL;
      pointLight.diffuse = new Color3(1, 1, 1);
      pointLight.specular = new Color3(0, 0, 0);
      // Standard/CEL light contributions use `1 - d / range` attenuation,
      // which no constant maps onto the provider's physical `1 / d^2`
      // irradiance. A directional light has attenuation 1 in every
      // convention, so `I * cos` is the realtime Standard/CEL diffuse and the
      // stored physical-E alike — the honest cross-convention oracle.
      const directionToLight: [number, number, number] = [
        normal[0] + 0.35,
        normal[1] + 0.2,
        normal[2] + 0.45,
      ];
      const fillLight = new DirectionalLight(
        "Fill",
        new Vector3(
          -directionToLight[0],
          -directionToLight[1],
          -directionToLight[2],
        ),
        scene,
      );
      fillLight.intensity = DIR_INTENSITY;
      fillLight.diffuse = new Color3(1, 1, 1);
      fillLight.specular = new Color3(0, 0, 0);
      const pointSampling = {
        texture: analyticAtlas(scene, (point) =>
          analyticPointIrradiance(
            point,
            normal,
            lightPosition,
            [1, 1, 1],
            LIGHT_INTENSITY,
          ),
        ),
        scale: [1, 1] as const,
        offset: [0, 0] as const,
        includesEnvironment: false,
      };
      const directionalSampling = {
        texture: analyticAtlas(scene, () =>
          analyticDirectionalIrradiance(
            normal,
            directionToLight,
            [1, 1, 1],
            DIR_INTENSITY,
          ),
        ),
        scale: [1, 1] as const,
        offset: [0, 0] as const,
        includesEnvironment: false,
      };
      const realtimePbr = pbr("Realtime PBR", scene);
      const bakedPbr = pbr("Baked PBR", scene);
      new BakedIrradiancePlugin(bakedPbr, pointSampling);
      const realtimeCel = cel("Realtime CEL", scene);
      const bakedCel = cel("Baked CEL", scene);
      new BakedIrradiancePlugin(bakedCel, directionalSampling);
      const captures = [] as Array<{ label: string; pixels: number[][] }>;
      for (const [label, material, point, fill] of [
        ["pbrRealtime", realtimePbr, true, false],
        ["pbrBaked", bakedPbr, false, false],
        ["celRealtime", realtimeCel, false, true],
        ["celBaked", bakedCel, false, false],
      ] as const) {
        pointLight.excludedMeshes.length = 0;
        if (!point) pointLight.excludedMeshes.push(mesh);
        fillLight.excludedMeshes.length = 0;
        if (!fill) fillLight.excludedMeshes.push(mesh);
        mesh.material = material;
        captures.push({ label, pixels: await row(engine, scene) });
      }
      result.push({
        backend,
        driver: "getGlInfo" in engine ? engine.getGlInfo() : engine.getInfo(),
        caps: {
          float: engine.getCaps().textureFloat,
          linear: engine.getCaps().textureFloatLinearFiltering,
        },
        rows: Object.fromEntries(
          captures.map((entry) => [entry.label, entry.pixels]),
        ),
        png: canvas.toDataURL("image/png"),
      });
    } finally {
      scene.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return result;
}
