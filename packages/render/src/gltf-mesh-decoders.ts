import { GLTF_MESH_DECODER_RELATIVE_FILES } from "@babylonslate/assets";

export { GLTF_MESH_DECODER_RELATIVE_FILES };

/**
 * Self-hosted Draco / meshopt decoder URLs for Babylon's glTF loader.
 * Never point at a CDN — editor and exports must work offline.
 */

export const DEFAULT_DRACO_PUBLIC_BASE = "/draco/";
export const DEFAULT_MESHOPT_PUBLIC_BASE = "/meshopt/";

export interface DracoDecoderUrls {
  wasmUrl: string;
  wasmBinaryUrl: string;
  fallbackUrl: string;
}

export interface GltfMeshDecoderUrls {
  draco: DracoDecoderUrls;
  meshopt: { url: string };
}

export type DracoDecoderConfigHost = {
  DefaultConfiguration: {
    wasmUrl?: string;
    wasmBinaryUrl?: string;
    fallbackUrl?: string;
    numWorkers?: number;
  };
  ResetDefault?: (skipDispose?: boolean) => void;
};

export type MeshoptCompressionHost = {
  Configuration: { decoder: { url: string } };
};

export type GltfMeshDecoderOptions = {
  dracoBasePath?: string;
  meshoptBasePath?: string;
  /**
   * Packed player / Preview iframe: decode on this thread so wasm URLs are
   * not loaded from a blob Worker (COEP / importScripts often fail there).
   */
  playMode?: boolean;
};

function slashTerminated(basePath: string): string {
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

export function gltfMeshDecoderUrls(
  dracoBasePath: string = DEFAULT_DRACO_PUBLIC_BASE,
  meshoptBasePath: string = DEFAULT_MESHOPT_PUBLIC_BASE,
): GltfMeshDecoderUrls {
  const draco = slashTerminated(dracoBasePath);
  const meshopt = slashTerminated(meshoptBasePath);
  return {
    draco: {
      wasmUrl: `${draco}draco_wasm_wrapper_gltf.js`,
      wasmBinaryUrl: `${draco}draco_decoder_gltf.wasm`,
      fallbackUrl: `${draco}draco_decoder_gltf.js`,
    },
    meshopt: { url: `${meshopt}meshopt_decoder.js` },
  };
}

/**
 * Point DracoDecoder / MeshoptCompression at vendored files. Kept free of a
 * hard Babylon import so unit tests can pass a mock.
 */
export function configureGltfMeshDecoders(
  draco: DracoDecoderConfigHost,
  meshopt: MeshoptCompressionHost,
  options: GltfMeshDecoderOptions = {},
): GltfMeshDecoderUrls {
  const urls = gltfMeshDecoderUrls(
    options.dracoBasePath,
    options.meshoptBasePath,
  );
  // `undefined` lets Babylon pick its default worker count.
  const numWorkers = options.playMode === true ? 0 : undefined;
  const current = draco.DefaultConfiguration;
  // The static default decoder is page-global and lazily warmed; replace it
  // only when its effective configuration changes.
  if (
    current.wasmUrl !== urls.draco.wasmUrl ||
    current.wasmBinaryUrl !== urls.draco.wasmBinaryUrl ||
    current.fallbackUrl !== urls.draco.fallbackUrl ||
    current.numWorkers !== numWorkers
  ) {
    draco.DefaultConfiguration = {
      ...current,
      wasmUrl: urls.draco.wasmUrl,
      wasmBinaryUrl: urls.draco.wasmBinaryUrl,
      fallbackUrl: urls.draco.fallbackUrl,
      numWorkers,
    };
    draco.ResetDefault?.(true);
  }
  meshopt.Configuration = {
    ...meshopt.Configuration,
    decoder: { url: urls.meshopt.url },
  };
  return urls;
}
