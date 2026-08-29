import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRACO_PUBLIC_BASE,
  DEFAULT_MESHOPT_PUBLIC_BASE,
  GLTF_MESH_DECODER_RELATIVE_FILES,
  configureGltfMeshDecoders,
  gltfMeshDecoderUrls,
} from "./gltf-mesh-decoders";

const editorPublic = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/editor/public",
);

describe("gltf mesh decoder config", () => {
  it("builds self-hosted Draco and meshopt URLs under the public bases", () => {
    const urls = gltfMeshDecoderUrls();
    expect(urls.draco.wasmUrl).toBe(
      `${DEFAULT_DRACO_PUBLIC_BASE}draco_wasm_wrapper_gltf.js`,
    );
    expect(urls.draco.wasmBinaryUrl).toBe(
      `${DEFAULT_DRACO_PUBLIC_BASE}draco_decoder_gltf.wasm`,
    );
    expect(urls.draco.fallbackUrl).toBe(
      `${DEFAULT_DRACO_PUBLIC_BASE}draco_decoder_gltf.js`,
    );
    expect(urls.meshopt.url).toBe(
      `${DEFAULT_MESHOPT_PUBLIC_BASE}meshopt_decoder.js`,
    );
    expect(GLTF_MESH_DECODER_RELATIVE_FILES).toEqual([
      "draco/draco_wasm_wrapper_gltf.js",
      "draco/draco_decoder_gltf.wasm",
      "draco/draco_decoder_gltf.js",
      "meshopt/meshopt_decoder.js",
    ]);
  });

  it("applies decoder URLs without reaching for a CDN", () => {
    const draco = {
      DefaultConfiguration: {
        wasmUrl: "https://cdn.babylonjs.com/draco_wasm_wrapper_gltf.js",
        wasmBinaryUrl: "https://cdn.babylonjs.com/draco_decoder_gltf.wasm",
        fallbackUrl: "https://cdn.babylonjs.com/draco_decoder_gltf.js",
        numWorkers: 4,
      },
    };
    const meshopt = {
      Configuration: {
        decoder: { url: "https://cdn.babylonjs.com/meshopt_decoder.js" },
      },
    };
    configureGltfMeshDecoders(draco, meshopt, {
      playMode: true,
      dracoBasePath: "/assets/draco",
      meshoptBasePath: "/assets/meshopt",
    });
    const joined = [
      draco.DefaultConfiguration.wasmUrl,
      draco.DefaultConfiguration.wasmBinaryUrl,
      draco.DefaultConfiguration.fallbackUrl,
      meshopt.Configuration.decoder.url,
    ].join(" ");
    expect(joined).not.toMatch(/cdn|http/i);
    expect(draco.DefaultConfiguration.wasmUrl).toBe(
      "/assets/draco/draco_wasm_wrapper_gltf.js",
    );
    expect(meshopt.Configuration.decoder.url).toBe(
      "/assets/meshopt/meshopt_decoder.js",
    );
    expect(draco.DefaultConfiguration.numWorkers).toBe(0);
  });
});

describe("vendored editor glTF mesh decoders", () => {
  it("ships Draco wasm and meshopt decoder under editor public/", () => {
    for (const relative of GLTF_MESH_DECODER_RELATIVE_FILES) {
      const path = join(editorPublic, relative);
      expect(existsSync(path), path).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.byteLength).toBeGreaterThan(100);
    }
    const wasm = readFileSync(
      join(editorPublic, "draco/draco_decoder_gltf.wasm"),
    );
    expect([...wasm.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
