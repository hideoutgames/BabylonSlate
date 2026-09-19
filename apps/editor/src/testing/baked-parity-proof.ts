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
  Scene,
  Vector3,
  type AbstractEngine,
  type BaseTexture,
} from "@babylonjs/core";
import type { BakedIrradianceAtlas } from "@babylonslate/core";
import { createAppEngine, createAppWebGpuEngine } from "@babylonslate/render";
import {
  analyticDirectionalIrradiance,
  analyticPointIrradiance,
} from "../../../../packages/render/src/baked-irradiance";
import { BakedIrradiancePlugin } from "../../../../packages/render/src/baked-irradiance-plugin";
import { acquireBakedAtlas } from "../../../../packages/render/src/baked-lighting-resources";
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

/**
 * rgba32float-le source bytes uploaded through the real `acquireBakedAtlas`
 * path (which narrows to RGBA16F); texel (i,j) holds the analytic E at the
 * surface point mapping to its center.
 */
async function analyticAtlas(
  engine: AbstractEngine,
  name: string,
  irradiance: (point: [number, number, number]) => [number, number, number],
): Promise<{ texture: BaseTexture; release(): void }> {
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
  const atlas = {
    sha256: `baked-parity-${name}`,
    width: ATLAS,
    height: ATLAS,
  } as BakedIrradianceAtlas;
  return acquireBakedAtlas(engine, atlas, bytes);
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
      const atlasLeases: Array<{ release(): void }> = [];
      try {
        const pointAtlas = await analyticAtlas(engine, "point", (point) =>
          analyticPointIrradiance(
            point,
            normal,
            lightPosition,
            [1, 1, 1],
            LIGHT_INTENSITY,
          ),
        );
        atlasLeases.push(pointAtlas);
        const directionalAtlas = await analyticAtlas(
          engine,
          "directional",
          () =>
            analyticDirectionalIrradiance(
              normal,
              directionToLight,
              [1, 1, 1],
              DIR_INTENSITY,
            ),
        );
        atlasLeases.push(directionalAtlas);
        const pointSampling = {
          texture: pointAtlas.texture,
          scale: [1, 1] as const,
          offset: [0, 0] as const,
          includesEnvironment: false,
        };
        const directionalSampling = {
          texture: directionalAtlas.texture,
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
        const captures = [] as Array<{
          label: string;
          pixels: number[][];
          slateBaked: boolean;
          lightDefines: number;
          bakedTexelSamples: number;
          bakedInjection: boolean;
        }>;
        for (const [label, material, point, fill] of [
          ["pbrRealtime", realtimePbr, true, false],
          ["pbrBaked", bakedPbr, false, false],
          ["celRealtime", realtimeCel, false, true],
          ["celBaked", bakedCel, false, false],
        ] as const) {
          // `mesh.lightSources` — the list material defines compile from — is
          // resynced only through Babylon's patched `push`/`splice` hooks on
          // `excludedMeshes`; `length = 0` clears the array without firing
          // them, so a re-included light would silently stay out of the
          // compiled effect. `setEnabled` resyncs every mesh explicitly.
          pointLight.setEnabled(point);
          fillLight.setEnabled(fill);
          mesh.material = material;
          const pixels = await row(engine, scene);
          const effect = mesh.subMeshes[0]?.effect;
          const defines = effect?.defines ?? "";
          const fragment = effect?.fragmentSourceCode ?? "";
          captures.push({
            label,
            pixels,
            slateBaked: defines.split("\n").includes("#define SLATE_BAKED"),
            lightDefines:
              defines.match(/#define (?:DIR|POINT|SPOT|HEMI)LIGHT\d+/g)
                ?.length ?? 0,
            bakedTexelSamples: (fragment.match(/slateBakedTexel/g) ?? [])
              .length,
            bakedInjection: fragment.includes(
              "diffuseBase+=slateBakedIrradianceSample",
            ),
          });
        }
        result.push({
          backend,
          driver: "getGlInfo" in engine ? engine.getGlInfo() : engine.getInfo(),
          caps: {
            halfFloat: engine.getCaps().textureHalfFloat,
            halfLinear: engine.getCaps().textureHalfFloatLinearFiltering,
          },
          atlas: {
            ready:
              pointSampling.texture.isReady() &&
              directionalSampling.texture.isReady(),
            halfFloat:
              pointSampling.texture.getInternalTexture()?.type ===
                Constants.TEXTURETYPE_HALF_FLOAT &&
              directionalSampling.texture.getInternalTexture()?.type ===
                Constants.TEXTURETYPE_HALF_FLOAT,
          },
          rows: Object.fromEntries(
            captures.map((entry) => [entry.label, entry.pixels]),
          ),
          diagnostics: Object.fromEntries(
            captures.map((entry) => [
              entry.label,
              {
                slateBaked: entry.slateBaked,
                lightDefines: entry.lightDefines,
                bakedTexelSamples: entry.bakedTexelSamples,
                bakedInjection: entry.bakedInjection,
              },
            ]),
          ),
          png: canvas.toDataURL("image/png"),
        });
      } finally {
        for (const lease of atlasLeases) lease.release();
      }
    } finally {
      scene.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return result;
}
