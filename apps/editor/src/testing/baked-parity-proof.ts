/** Test-build-only shading oracle: analytic physical-E atlas vs realtime point light. */
import {
  Color3,
  Color4,
  Constants,
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
import { analyticPointIrradiance } from "../../../../packages/render/src/baked-irradiance";
import { BakedIrradiancePlugin } from "../../../../packages/render/src/baked-irradiance-plugin";
import { CelMaterial } from "../../../../packages/render/src/cel-material";

const SIZE = 96;
const ATLAS = 64;
const PLANE = 4;
const LIGHT_INTENSITY = 4;

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
  normal: readonly [number, number, number],
  lightPosition: readonly [number, number, number],
): BaseTexture {
  const bytes = new Uint8Array(ATLAS * ATLAS * 16);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < ATLAS; y++)
    for (let x = 0; x < ATLAS; x++) {
      const point: [number, number, number] = [
        -PLANE / 2 + (PLANE * (x + 0.5)) / ATLAS,
        -PLANE / 2 + (PLANE * (y + 0.5)) / ATLAS,
        0,
      ];
      const e = analyticPointIrradiance(
        point,
        normal,
        lightPosition,
        [1, 1, 1],
        LIGHT_INTENSITY,
      );
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
      const light = new PointLight(
        "Lamp",
        new Vector3(...lightPosition),
        scene,
      );
      light.intensity = LIGHT_INTENSITY;
      light.falloffType = Light.FALLOFF_PHYSICAL;
      light.diffuse = new Color3(1, 1, 1);
      light.specular = new Color3(0, 0, 0);
      const atlas = analyticAtlas(scene, normal, lightPosition);
      const sampling = {
        texture: atlas,
        scale: [1, 1] as const,
        offset: [0, 0] as const,
        includesEnvironment: false,
      };
      const realtimePbr = pbr("Realtime PBR", scene);
      const bakedPbr = pbr("Baked PBR", scene);
      new BakedIrradiancePlugin(bakedPbr, sampling);
      const realtimeCel = cel("Realtime CEL", scene);
      const bakedCel = cel("Baked CEL", scene);
      new BakedIrradiancePlugin(bakedCel, sampling);
      const captures = [] as Array<{ label: string; pixels: number[][] }>;
      for (const [label, material, excluded] of [
        ["pbrRealtime", realtimePbr, false],
        ["pbrBaked", bakedPbr, true],
        ["celRealtime", realtimeCel, false],
        ["celBaked", bakedCel, true],
      ] as const) {
        light.excludedMeshes.length = 0;
        if (excluded) light.excludedMeshes.push(mesh);
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
