/** Test-build-only raw irradiance/geometry contract oracle; no production shading is selected. */
import {
  Color4,
  FreeCamera,
  Geometry,
  Mesh,
  Scene,
  ShaderLanguage,
  ShaderMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  type AbstractEngine,
} from "@babylonjs/core";
import { createAppEngine, createAppWebGpuEngine } from "@babylonslate/render";
import { SceneBakedLighting } from "@babylonslate/render/scene-baked-lighting";
import { bakedGpuAllocationStatus } from "../../../../packages/render/src/baked-lighting-resources";
import {
  bakedGeometryImportResult,
  bakedLightingImportResult,
  encodeBakedGeometryAsset,
  encodeBakedLightingAsset,
  encodeBakeTopology,
  fingerprintBakeGeometry,
  sha256Hex,
} from "@babylonslate/assets";
import type {
  BakeGeometrySource,
  BakedLightingManifest,
} from "@babylonslate/core";

const source: BakeGeometrySource = {
  vertexCount: 4,
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  attributes: [
    {
      name: "position",
      componentType: "f32",
      components: 3,
      normalized: false,
      data: new Uint8Array(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]).buffer,
      ),
    },
    {
      name: "packed",
      componentType: "u8",
      components: 1,
      normalized: false,
      data: new Uint8Array([11, 22, 33, 44]),
    },
  ],
};
const topology = {
  indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  originalVertices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
};

async function assets(sceneGuid: string, offset: number) {
  const geometryHash = await fingerprintBakeGeometry(source);
  const hash = "a".repeat(64);
  const inputs = {
    geometry: geometryHash,
    uv: hash,
    transforms: hash,
    materials: hash,
    lights: hash,
    environment: hash,
    settings: hash,
    provider: hash,
  };
  const identity = {
    actorId: "actor",
    componentId: "mesh",
    primitive: { kind: "mesh" as const },
  };
  const contentHash = await sha256Hex(encodeBakeTopology(topology, 4));
  const atlas = new Uint8Array(16 * 16 * 16);
  const values = new DataView(atlas.buffer);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const color =
        y < 8
          ? x < 8
            ? [0.2, 0, 0, 1]
            : [0, 0.4, 0, 1]
          : x < 8
            ? [0, 0, 0.6, 1]
            : [0.8, 0.8, 0, 1];
      color.forEach((value, channel) =>
        values.setFloat32((y * 16 + x) * 16 + channel * 4, value, true),
      );
    }
  const geometryGuid = `geometry-${sceneGuid}`,
    bakeGuid = `bake-${sceneGuid}`;
  const receiver = {
    identity,
    mobility: "static" as const,
    hashes: {
      geometry: geometryHash,
      uv: hash,
      transforms: hash,
      materials: hash,
    },
    generatedGeometry: { assetGuid: geometryGuid, contentHash },
    atlasGuid: "atlas",
    scale: [0.5, 1] as [number, number],
    offset: [offset, 0] as [number, number],
    contributions: [{ sourceId: "light", term: "directAndIndirect" as const }],
  };
  const manifest: BakedLightingManifest = {
    version: 1,
    sceneGuid,
    inputs,
    provider: { id: "numeric-fixture", version: "1", adapterVersion: "1" },
    settingsVersion: "1",
    dependencies: [geometryGuid],
    sources: [
      {
        id: "light",
        kind: "light",
        actorId: "light",
        componentId: "light",
        mobility: "static",
        inputHash: hash,
      },
    ],
    receivers: [receiver],
    atlases: [
      {
        guid: "atlas",
        chunkId: "atlas",
        width: 16,
        height: 16,
        sha256: await sha256Hex(atlas),
        encoding: "rgba32float-le",
        colorSpace: "linear",
        quantity: "diffuseIrradiance",
        convention: "physical-E",
        alpha: "coverage",
        rowOrder: "bottomFirst",
        uvSet: 1,
        mipLevels: 1,
        gutterTexels: 0,
      },
    ],
  };
  const geometry = await encodeBakedGeometryAsset(
    await bakedGeometryImportResult({
      guid: geometryGuid,
      name: "Geometry",
      topology,
      manifest: {
        version: 1,
        sceneGuid,
        receiver: identity,
        sourceHash: geometryHash,
        sourceVertexCount: 4,
        indexCount: 6,
        vertexCount: 6,
        contentHash,
        provider: manifest.provider,
        layout: {
          width: 16,
          height: 16,
          paddingTexels: 0,
          uvSet: 1,
          coordinates: "normalized-bottom-first",
          mipLevels: 1,
        },
      },
    }),
  );
  const lighting = await encodeBakedLightingAsset(
    await bakedLightingImportResult({
      guid: bakeGuid,
      name: "Lighting",
      manifest,
      atlases: new Map([["atlas", atlas]]),
    }),
  );
  return {
    inputs,
    receiver,
    bakeGuid,
    payloads: new Map([
      [bakeGuid, lighting],
      [geometryGuid, geometry],
    ]),
  };
}

function geometry(scene: Scene) {
  const mesh = new Mesh("Receiver", scene);
  const geometry = new Geometry("Original", scene);
  geometry.setVerticesData(
    "position",
    new Float32Array(source.attributes[0].data.buffer.slice(0)),
    false,
    3,
  );
  geometry.setIndices(source.indices.slice(), 4);
  geometry.setVerticesBuffer(
    new VertexBuffer(
      scene.getEngine(),
      source.attributes[1].data.slice(),
      "packed",
      {
        size: 1,
        stride: 1,
        useBytes: true,
        type: VertexBuffer.UNSIGNED_BYTE,
      },
    ),
    4,
  );
  geometry.applyToMesh(mesh);
  return mesh;
}

function material(scene: Scene) {
  const wgsl = scene.getEngine().isWebGPU;
  const vertexSource = wgsl
    ? `attribute position: vec3f; attribute uv2: vec2f; varying vUV: vec2f;
@vertex fn main(input: VertexInputs) -> FragmentInputs { vertexOutputs.position=vec4f(vertexInputs.position,1.0); vertexOutputs.vUV=vertexInputs.uv2; }`
    : `precision highp float; attribute vec3 position; attribute vec2 uv2; varying vec2 vUV;
void main(){ gl_Position=vec4(position,1.0); vUV=uv2; }`;
  const fragmentSource = wgsl
    ? `varying vUV: vec2f; uniform atlasRect: vec4f; var irradianceSampler: sampler; var irradiance: texture_2d<f32>;
@fragment fn main(input: FragmentInputs) -> FragmentOutputs { fragmentOutputs.color=vec4f(textureSample(irradiance,irradianceSampler,fragmentInputs.vUV*uniforms.atlasRect.xy+uniforms.atlasRect.zw).rgb,1.0); }`
    : `precision highp float; varying vec2 vUV; uniform vec4 atlasRect; uniform sampler2D irradiance;
void main(){ gl_FragColor=vec4(texture2D(irradiance,vUV*atlasRect.xy+atlasRect.zw).rgb,1.0); }`;
  const result = new ShaderMaterial(
    "Raw physical E",
    scene,
    { vertexSource, fragmentSource },
    {
      attributes: ["position", "uv2"],
      uniforms: ["atlasRect"],
      samplers: ["irradiance"],
      shaderLanguage: wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    },
  );
  result.backFaceCulling = false;
  return result;
}

async function capture(
  engine: AbstractEngine,
  scene: Scene,
  canvas: HTMLCanvasElement,
) {
  await scene.whenReadyAsync();
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  const pixels = await engine.readPixels(0, 0, 64, 64);
  const data = new Uint8Array(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength,
  );
  const bgra =
    engine.isWebGPU &&
    navigator.gpu.getPreferredCanvasFormat() === "bgra8unorm";
  const pixel = (x: number, bottomY: number) => {
    const y = engine.isWebGPU ? 63 - bottomY : bottomY;
    const value = Array.from(
      data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    );
    return bgra ? [value[2], value[1], value[0], value[3]] : value;
  };
  return {
    bottom: pixel(32, 16),
    top: pixel(32, 48),
    png: canvas.toDataURL("image/png"),
  };
}

export async function runBakedRuntimeProof() {
  const result = [];
  for (const backend of ["webgl2", "webgpu"] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    document.getElementById("root")!.append(canvas);
    const engine =
      backend === "webgpu"
        ? await createAppWebGpuEngine(canvas)
        : createAppEngine(canvas);
    const scenes: Scene[] = [];
    try {
      const entries = [];
      for (const [sceneGuid, offset] of [
        ["left", 0],
        ["right", 0.5],
      ] as const) {
        const scene = new Scene(engine);
        scenes.push(scene);
        scene.clearColor = new Color4(0, 0, 0, 1);
        new FreeCamera("Camera", new Vector3(0, 0, -3), scene);
        const mesh = geometry(scene),
          original = mesh.geometry!;
        const data = await assets(sceneGuid, offset);
        const owner = new SceneBakedLighting(scene);
        await owner.load({
          assetGuid: data.bakeGuid,
          sceneGuid,
          inputs: data.inputs,
          receivers: [
            {
              mesh,
              identity: data.receiver.identity,
              hashes: data.receiver.hashes,
            },
          ],
          readAsset: async (guid) => {
            const bytes = data.payloads.get(guid);
            return bytes && { bytes };
          },
          isCurrent: () => true,
        });
        const binding = owner.bindingFor(mesh)!;
        const shader = material(scene);
        shader.setTexture("irradiance", binding.texture);
        shader.setVector4(
          "atlasRect",
          new Vector4(...binding.receiver.scale, ...binding.receiver.offset),
        );
        mesh.material = shader;
        await shader.forceCompilationAsync(mesh);
        entries.push({
          scene,
          mesh,
          original,
          owner,
          binding,
          capture: await capture(engine, scene, canvas),
        });
      }
      const [a, b] = entries;
      const internal = a.binding.texture.getInternalTexture()!;
      const shared = internal === b.binding.texture.getInternalTexture();
      const bytesBefore = bakedGpuAllocationStatus(engine);
      let alignmentRejected = false;
      if (engine.isWebGPU) {
        const scene = new Scene(engine);
        scenes.push(scene);
        const mesh = geometry(scene),
          original = mesh.geometry;
        const data = await assets("budget", 0);
        const owner = new SceneBakedLighting(
          scene,
          bytesBefore.managedBytes + 150,
        );
        try {
          await owner.load({
            assetGuid: data.bakeGuid,
            sceneGuid: "budget",
            inputs: data.inputs,
            receivers: [
              {
                mesh,
                identity: data.receiver.identity,
                hashes: data.receiver.hashes,
              },
            ],
            readAsset: async (guid) => {
              const bytes = data.payloads.get(guid);
              return bytes && { bytes };
            },
            isCurrent: () => true,
          });
        } catch (error) {
          alignmentRejected =
            error instanceof Error &&
            /allocation budget/.test(error.message) &&
            mesh.geometry === original &&
            mesh.getTotalVertices() === 4 &&
            bakedGpuAllocationStatus(engine).managedBytes ===
              bytesBefore.managedBytes;
        } finally {
          scene.dispose();
        }
      }
      a.owner.invalidate();
      const restored =
        a.mesh.geometry === a.original && a.mesh.getTotalVertices() === 4;
      a.scene.dispose();
      const remaining = await capture(engine, b.scene, canvas);
      b.scene.dispose();
      const bytesAwaitingRelease =
        bakedGpuAllocationStatus(engine).managedBytes;
      // This isolated harness owns its Engine; the service itself never submits a sibling's frame.
      engine.beginFrame();
      engine.endFrame();
      result.push({
        backend,
        driver: "getGlInfo" in engine ? engine.getGlInfo() : engine.getInfo(),
        caps: {
          float: engine.getCaps().textureFloat,
          linear: engine.getCaps().textureFloatLinearFiltering,
        },
        captures: { left: a.capture, right: b.capture, remaining },
        shared,
        alignmentRejected,
        restored,
        bytesBefore,
        bytesAwaitingRelease,
        bytesAfter: bakedGpuAllocationStatus(engine),
        atlasReleased: !engine.getLoadedTexturesCache().includes(internal),
      });
    } finally {
      for (const scene of scenes) scene.dispose();
      engine.dispose();
      canvas.remove();
    }
  }
  return result;
}
