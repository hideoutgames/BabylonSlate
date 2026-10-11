import { normalizeWaterDefinition } from "@babylonslate/core";
import {
  normalizeInputAssetPayload,
  validateSaveGameDefinition,
  normalizeSceneLayer,
  normalizeDataDefinitionAsset,
  normalizeDataTreeAsset,
  normalizePrefab,
} from "@babylonslate/core";
import { normalizeParticleGraphDocument } from "@babylonslate/particle-graph";
import { normalizeMaterialFunctionDocument } from "@babylonslate/shader-graph";
import {
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeSoundAttenuationPayload,
} from "./audio-payload";
import { normalizeParticleEmitterPayload } from "./particle-basic-emitter";
import { normalizeParticleSystemPayload } from "./particle-payload";
import { normalizeSkyboxCreatorPayload } from "./skybox-creator-payload";

export type MigrationFn = (
  payload: Record<string, unknown>,
) => Record<string, unknown>;

export interface TypeMigrationChain {
  type: string;
  /** migrations[i] migrates version i → i+1. Current version = migrations.length. */
  migrations: MigrationFn[];
}

export class MigrationRegistry {
  private readonly chains = new Map<string, TypeMigrationChain>();

  register(chain: TypeMigrationChain): void {
    this.chains.set(chain.type, chain);
  }

  currentVersion(type: string): number {
    return this.chains.get(type)?.migrations.length ?? 0;
  }

  /**
   * Apply ordered migrations so payload matches the current schema version.
   * Refuses future versions.
   */
  migrate(
    type: string,
    version: number,
    payload: Record<string, unknown>,
  ): { version: number; payload: Record<string, unknown>; migrated: boolean } {
    const chain = this.chains.get(type);
    if (!chain) {
      return { version, payload, migrated: false };
    }
    const current = chain.migrations.length;
    if (version > current) {
      throw new Error(
        `Asset type "${type}" version ${version} was made with a newer engine version (current ${current})`,
      );
    }
    if (version === current) {
      return { version, payload, migrated: false };
    }
    let next = payload;
    for (let v = version; v < current; v++) {
      next = chain.migrations[v]!(next);
    }
    return { version: current, payload: next, migrated: true };
  }
}

/**
 * A version step whose payload needs no change, kept so the type's current
 * version number stays where saved files have it. Older shapes are not
 * converted: the type's normalizer fills current defaults on load.
 */
function keepPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload };
}

/** Default registry with the Class logic-graph chain and Scene/Project. */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({
    type: "Class",
    migrations: [
      (payload) => ({
        ...payload,
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        edges: Array.isArray(payload.edges) ? payload.edges : [],
      }),
    ],
  });
  registry.register({
    type: "Scene",
    migrations: [keepPayload, keepPayload, keepPayload, keepPayload],
  });
  registry.register({
    type: "Project",
    migrations: [(payload) => ({ ...payload })],
  });
  // Version 2 is the authored Material graph.
  registry.register({ type: "Material", migrations: [keepPayload, keepPayload] });
  registry.register({
    type: "MaterialFunction",
    migrations: [
      (payload) =>
        normalizeMaterialFunctionDocument(payload) as unknown as Record<
          string,
          unknown
        >,
    ],
  });
  // Header payload is a summary ({ domain, parentGuid }); the document chunk holds the instance.
  registry.register({
    type: "MaterialInstance",
    migrations: [(payload) => ({ ...payload })],
  });
  const asRecord = <T extends object>(value: T): Record<string, unknown> =>
    value as unknown as Record<string, unknown>;
  registry.register({
    type: "DataDefinition",
    migrations: [(payload) => asRecord(normalizeDataDefinitionAsset(payload))],
  });
  registry.register({
    type: "DataTree",
    migrations: [(payload) => asRecord(normalizeDataTreeAsset(payload))],
  });
  for (const type of ["InputAction", "InputAxis"] as const) {
    registry.register({
      type,
      migrations: [
        (payload) => asRecord(normalizeInputAssetPayload(type, payload)),
      ],
    });
  }
  registry.register({
    type: "Prefab",
    migrations: [(payload) => asRecord(normalizePrefab(payload))],
  });
  registry.register({
    type: "SaveGame",
    migrations: [(payload) => ({ ...validateSaveGameDefinition(payload) })],
  });
  registry.register({
    type: "Audio",
    migrations: [(payload) => ({ ...payload })],
  });
  registry.register({
    type: "AudioMixer",
    migrations: [(payload) => asRecord(normalizeAudioMixerPayload(payload))],
  });
  registry.register({
    type: "AudioChannel",
    migrations: [(payload) => asRecord(normalizeAudioChannelPayload(payload))],
  });
  registry.register({
    type: "SoundAttenuation",
    migrations: [
      (payload) => asRecord(normalizeSoundAttenuationPayload(payload)),
    ],
  });
  registry.register({
    type: "ParticleEmitter",
    migrations: [
      (payload) => asRecord(normalizeParticleEmitterPayload(payload)),
    ],
  });
  registry.register({
    type: "ParticleGraph",
    migrations: [
      (payload) => asRecord(normalizeParticleGraphDocument(payload)),
    ],
  });
  registry.register({
    type: "ParticleSystem",
    migrations: [
      (payload) => asRecord(normalizeParticleSystemPayload(payload)),
    ],
  });
  registry.register({
    type: "Water",
    migrations: [(payload) => asRecord(normalizeWaterDefinition(payload))],
  });
  registry.register({
    type: "SkyboxCreator",
    migrations: [(payload) => asRecord(normalizeSkyboxCreatorPayload(payload))],
  });
  registry.register({
    type: "SceneLayer",
    migrations: [(payload) => asRecord(normalizeSceneLayer(payload))],
  });
  return registry;
}

/** Current Material payload version (domain + graph + preview settings). */
export const MATERIAL_PAYLOAD_VERSION = 2;
