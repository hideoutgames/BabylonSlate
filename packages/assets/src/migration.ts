import { SCENE_SCHEMA_VERSION } from "@haptic/core";

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

/**
 * A stored schema version this engine refuses: older than any registered
 * step reads, or newer than current. Its message is written for the user.
 */
export class AssetFormatVersionError extends Error {
  override readonly name = "AssetFormatVersionError";
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

  /** Registered type names. */
  types(): string[] {
    return [...this.chains.keys()];
  }

  currentVersion(type: string): number {
    return this.chains.get(type)?.currentVersion ?? 0;
  }

  /** Throws for a stored version no registered step reads, or a future one. */
  private refuseUnreadable(chain: TypeMigrationChain, version: number): void {
    const { type, currentVersion: current } = chain;
    if (version > current) {
      throw new AssetFormatVersionError(
        `Asset type "${type}" version ${version} was made with a newer engine version (current ${current})`,
      );
    }
    const oldest = current - (chain.migrations?.length ?? 0);
    if (version < oldest) {
      throw new AssetFormatVersionError(
        `Asset type "${type}" version ${version} uses an unsupported old format. This engine reads version ${current}${oldest < current ? ` and upgrades from version ${oldest}` : ""}; older files are not upgraded.`,
      );
    }
  }

  /**
   * Play, Preview Build and export read stored payloads without migrating
   * them, so a registered type must be at its current version. Versions that
   * `migrate` refuses throw its message; an upgradable one must be saved first.
   */
  requireCurrent(type: string, version: number): void {
    const chain = this.chains.get(type);
    if (!chain || version === chain.currentVersion) return;
    this.refuseUnreadable(chain, version);
    throw new AssetFormatVersionError(
      `Asset type "${type}" version ${version} must be upgraded to version ${chain.currentVersion} before it can be played or exported. Open it and save with Migrate On Save.`,
    );
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
    if (version === current) {
      return { version, payload, migrated: false };
    }
    this.refuseUnreadable(chain, version);
    const steps = chain.migrations ?? [];
    const oldest = current - steps.length;
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
 * Schema version each versioned asset type was released at. Released files
 * stay readable: a format change raises the type's version in
 * `CURRENT_VERSIONS` and adds a step from the previous version to
 * `MIGRATIONS`, each tested with a committed golden of the version it reads
 * (`__fixtures__/migrations/<Type>-v<N>.hasset`). Never lower an entry; a
 * type added later joins at its first version. Versions older than these
 * predate the release and are refused.
 */
export const RELEASED_VERSIONS: Readonly<Record<string, number>> = {
  Class: 1,
  Scene: 4,
  Project: 1,
  Material: 2,
  MaterialFunction: 1,
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

/** Current schema version of each versioned asset type. */
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

/**
 * Migration steps per type, oldest first, ending at its current version:
 * the last step reads `CURRENT_VERSIONS[type] - 1`.
 */
const MIGRATIONS: Readonly<Record<string, readonly MigrationFn[]>> = {};

/** Default registry: every versioned type at its current version with its migration steps. */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  for (const [type, currentVersion] of Object.entries(CURRENT_VERSIONS)) {
    registry.register({ type, currentVersion, migrations: MIGRATIONS[type] });
  }
  return registry;
}
