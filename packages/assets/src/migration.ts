import { SCENE_SCHEMA_VERSION } from "@babylonslate/core";

export type MigrationFn = (
  payload: Record<string, unknown>,
) => Record<string, unknown>;

export interface TypeMigrationChain {
  type: string;
  /** Schema version this engine writes and reads for the type. */
  currentVersion: number;
  /**
   * Ordered steps ending at `currentVersion`: `migrations[i]` migrates
   * version `currentVersion - migrations.length + i` to the next one. Stored
   * versions older than the first step are refused as an unsupported old
   * format. Omit for a type that has no supported older format.
   */
  migrations?: readonly MigrationFn[];
}

export class MigrationRegistry {
  private readonly chains = new Map<string, TypeMigrationChain>();

  register(chain: TypeMigrationChain): void {
    const steps = chain.migrations?.length ?? 0;
    if (!Number.isInteger(chain.currentVersion) || chain.currentVersion < steps) {
      throw new Error(
        `Asset type "${chain.type}" current version ${chain.currentVersion} cannot follow ${steps} migration steps`,
      );
    }
    this.chains.set(chain.type, chain);
  }

  currentVersion(type: string): number {
    return this.chains.get(type)?.currentVersion ?? 0;
  }

  /**
   * Apply ordered migrations so payload matches the current schema version.
   * Refuses future versions and old versions no registered step reads.
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
    const current = chain.currentVersion;
    if (version > current) {
      throw new Error(
        `Asset type "${type}" version ${version} was made with a newer engine version (current ${current})`,
      );
    }
    if (version === current) {
      return { version, payload, migrated: false };
    }
    const steps = chain.migrations ?? [];
    const oldest = current - steps.length;
    if (version < oldest) {
      throw new Error(
        `Asset type "${type}" version ${version} uses an unsupported old format. This engine reads version ${current}${oldest < current ? ` and upgrades from version ${oldest}` : ""}; older files are not upgraded.`,
      );
    }
    let next = payload;
    for (let v = version; v < current; v++) {
      next = steps[v - oldest]!(next);
    }
    return { version: current, payload: next, migrated: true };
  }
}

/** Current Material payload version (domain + graph + preview settings). */
export const MATERIAL_PAYLOAD_VERSION = 2;

/**
 * Current schema version of each versioned asset type. The engine is
 * unreleased, so no type registers a migration step: a file at an older
 * version is refused rather than upgraded. Add steps here when a released
 * format must be read again.
 */
const CURRENT_VERSIONS: Readonly<Record<string, number>> = {
  Class: 1,
  Scene: SCENE_SCHEMA_VERSION,
  Project: 1,
  Material: MATERIAL_PAYLOAD_VERSION,
  MaterialFunction: 1,
  // Header payload is a summary ({ domain, parentGuid }); the document chunk holds the instance.
  MaterialInstance: 1,
  DataDefinition: 1,
  DataTree: 1,
  InputAction: 1,
  InputAxis: 1,
  Prefab: 1,
  SaveGame: 1,
  Audio: 1,
  AudioMixer: 1,
  AudioChannel: 1,
  SoundAttenuation: 1,
  ParticleEmitter: 1,
  ParticleGraph: 1,
  ParticleSystem: 1,
  Water: 1,
  SkyboxCreator: 1,
  SceneLayer: 1,
};

/** Default registry: every versioned type at its current version, with no migration steps. */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  for (const [type, currentVersion] of Object.entries(CURRENT_VERSIONS)) {
    registry.register({ type, currentVersion });
  }
  return registry;
}
