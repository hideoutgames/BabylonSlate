/** Persisted bake identities belong to authored documents, never renderer objects. */
export interface BakedReceiverIdentity {
  actorId: string;
  componentId: string;
  primitive:
    | { kind: "mesh" }
    | {
        kind: "model";
        assetGuid: string;
        nodeIndex: number;
        meshIndex: number;
        primitiveIndex: number;
      };
}

/** Every category participates in validity, including indirect-light inputs. */
export interface BakeInputHashes {
  geometry: string;
  uv: string;
  transforms: string;
  materials: string;
  lights: string;
  environment: string;
  settings: string;
  provider: string;
}

export type BakedLightingSource =
  | {
      id: string;
      kind: "light";
      actorId: string;
      componentId: string;
      mobility: "static" | "stationary";
      inputHash: string;
    }
  | {
      id: string;
      kind: "environment";
      assetGuid: string;
      inputHash: string;
    };

export interface BakedReceiverBinding {
  identity: BakedReceiverIdentity;
  /** V1 mesh atlases bind only static receivers; moving receivers need a separate probe representation. */
  mobility: "static";
  hashes: Pick<BakeInputHashes, "geometry" | "uv" | "transforms" | "materials">;
  atlasGuid: string;
  /** Absent for authored UV2. Generated topology is a separately bounded immutable asset. */
  generatedGeometry?: { assetGuid: string; contentHash: string };
  /** UV2 maps into this normalized atlas rectangle; gutters are outside it. */
  scale: [number, number];
  offset: [number, number];
  /** Per receiver: two instances in the same atlas may have different masks. */
  contributions: Array<{
    sourceId: string;
    term: "directAndIndirect" | "indirectOnly" | "environmentDiffuse";
  }>;
}

export interface BakedIrradianceAtlas {
  guid: string;
  chunkId: string;
  width: number;
  height: number;
  sha256: string;
  encoding: "rgba32float-le";
  colorSpace: "linear";
  quantity: "diffuseIrradiance";
  /** Physical E, before diffuse albedo / pi, CEL bands, or output conversion. */
  convention: "physical-E";
  alpha: "coverage";
  rowOrder: "bottomFirst";
  uvSet: 1;
  mipLevels: 1;
  gutterTexels: number;
}

export interface BakedLightingManifest {
  version: 1;
  sceneGuid: string;
  inputs: BakeInputHashes;
  provider: { id: string; version: string; adapterVersion: string };
  settingsVersion: string;
  /** Asset dependencies needed to identify the authored inputs, excluding the owner Scene. */
  dependencies: string[];
  sources: BakedLightingSource[];
  receivers: BakedReceiverBinding[];
  atlases: BakedIrradianceAtlas[];
}

export type BakedLightingValidity =
  | { status: "missing"; reason: string }
  | { status: "stale"; reasons: string[] }
  | { status: "valid" };
