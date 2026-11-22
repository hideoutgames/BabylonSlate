import { isExtensionAssetType, SCENE_SCHEMA_VERSION, type AssetType } from "@haptic/core";

/** Every versioned `.hasset` header type: the built-in asset types plus the `.hproject` manifest. */
export type VersionedAssetType = AssetType | "Project";

/**
 * A stored schema version this engine refuses: older or newer than the one it
 * reads. Its message is written for the user.
 */
export class AssetFormatVersionError extends Error {
  override readonly name = "AssetFormatVersionError";
}

/**
 * Schema version of extension asset types (`extension.<guid>.<typeId>`). The
 * extension owns its payload's shape; the container version is fixed.
 */
export const EXTENSION_ASSET_FORMAT_VERSION = 1;

/**
 * The schema version each asset type is read and written at. Reads are strict:
 * a stored version other than the current one is refused, never upgraded.
 */
export class MigrationRegistry {
  private readonly versions = new Map<string, number>();

  register(entry: { type: string; currentVersion: number }): void {
    if (!Number.isInteger(entry.currentVersion) || entry.currentVersion < 1) {
      throw new Error(`Asset type "${entry.type}" current version ${entry.currentVersion} must be a whole number from 1`);
    }
    this.versions.set(entry.type, entry.currentVersion);
  }

  /** Registered type names. */
  types(): string[] {
    return [...this.versions.keys()];
  }

  /** The version a save writes. Throws for a type with no registered version, so nothing writes version 0. */
  currentVersion(type: string): number {
    const version = this.versions.get(type) ?? (isExtensionAssetType(type) ? EXTENSION_ASSET_FORMAT_VERSION : undefined);
    if (version === undefined) throw new Error(`Asset type "${type}" has no registered schema version`);
    return version;
  }

  /**
   * Opening, Play, Preview Build and export read stored payloads as they are,
   * so the stored version must be the current one. Throws
   * {@link AssetFormatVersionError} for an older or newer version and for a
   * type this engine does not know.
   */
  requireCurrent(type: string, version: number): void {
    const known = this.versions.has(type) || isExtensionAssetType(type);
    if (!known) {
      throw new AssetFormatVersionError(`Asset type "${type}" is not known to this engine version`);
    }
    const current = this.currentVersion(type);
    if (version === current) return;
    if (version > current) {
      throw new AssetFormatVersionError(
        `Asset type "${type}" version ${version} was made with a newer engine version (current ${current})`,
      );
    }
    throw new AssetFormatVersionError(
      `Asset type "${type}" version ${version} uses an unsupported old format. This engine reads version ${current}; older files are not upgraded.`,
    );
  }
}

/** Current Material payload version (domain + graph + preview settings). */
export const MATERIAL_PAYLOAD_VERSION = 1;

/**
 * Schema version of each asset type at the first release. Haptic is not
 * released yet: formats change in place without raising versions, every type
 * stays at 1 and these equal `CURRENT_VERSIONS`. From the first release on,
 * released files stay readable: a format change raises the type's version in
 * `CURRENT_VERSIONS` and adds an upgrade step from the previous version, each
 * tested with a committed golden of the version it reads. Never lower an
 * entry after the release; a type added later joins at its first version.
 */
export const RELEASED_VERSIONS = {
  Scene: 1,
  SceneLayer: 1,
  Class: 1,
  Prefab: 1,
  Font: 1,
  Sprite: 1,
  SpriteAnimation: 1,
  AnimationGraph3D: 1,
  AnimationGraph2D: 1,
  BlendSpace: 1,
  SpriteBlendSpace: 1,
  BehaviourTree: 1,
  Blackboard: 1,
  SaveGame: 1,
  Material: 1,
  MaterialFunction: 1,
  MaterialInstance: 1,
  Tileset: 1,
  Tilemap: 1,
  Enum: 1,
  Structure: 1,
  DataDefinition: 1,
  DataTree: 1,
  FloatCurve: 1,
  VectorCurve: 1,
  ColorCurve: 1,
  GlobalParameterCollection: 1,
  Timeline: 1,
  TimelineClip2D: 1,
  TimelineClip3D: 1,
  ScriptInterface: 1,
  PluginSettings: 1,
  Audio: 1,
  InputAction: 1,
  InputAxis: 1,
  AudioMixer: 1,
  AudioChannel: 1,
  SoundAttenuation: 1,
  CameraShake: 1,
  ParticleEmitter: 1,
  ParticleGraph: 1,
  ParticleSystem: 1,
  Water: 1,
  Model: 1,
  Skeleton: 1,
  Animation: 1,
  SkyboxCreator: 1,
  Trace: 1,
  Texture: 1,
  RenderTarget: 1,
  RenderTargetTexture: 1,
  Project: 1,
} as const satisfies Record<VersionedAssetType, number>;

/** Current schema version of each asset type. Exhaustive: a new asset type does not compile until it is listed. */
const CURRENT_VERSIONS = {
  ...RELEASED_VERSIONS,
  Scene: SCENE_SCHEMA_VERSION,
  Material: MATERIAL_PAYLOAD_VERSION,
} as const satisfies Record<VersionedAssetType, number>;

/** Default registry: every asset type at its current version. */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  for (const [type, currentVersion] of Object.entries(CURRENT_VERSIONS)) {
    registry.register({ type, currentVersion });
  }
  return registry;
}
