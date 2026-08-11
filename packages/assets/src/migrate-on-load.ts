import type { MigrationRegistry } from "./migration";
import { createDefaultMigrationRegistry } from "./migration";

export interface MigrationPending {
  type: string;
  fromVersion: number;
  toVersion: number;
  path: string;
}

export interface LoadWithMigrationResult {
  payload: Record<string, unknown>;
  version: number;
  pending: MigrationPending | null;
}

/**
 * Apply migrations on load. Does not rewrite files — caller must prompt and
 * migrate-on-save (never silent rewrite of untouched files).
 */
export function loadPayloadWithMigration(
  registry: MigrationRegistry,
  options: {
    type: string;
    version: number;
    payload: Record<string, unknown>;
    path: string;
  },
): LoadWithMigrationResult {
  const result = registry.migrate(options.type, options.version, options.payload);
  return {
    payload: result.payload,
    version: result.version,
    pending: result.migrated
      ? {
          type: options.type,
          fromVersion: options.version,
          toVersion: result.version,
          path: options.path,
        }
      : null,
  };
}

export function defaultRegistry(): MigrationRegistry {
  return createDefaultMigrationRegistry();
}
