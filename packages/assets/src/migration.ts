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
    const current = chain?.migrations.length ?? 0;
    if (version > current) {
      throw new Error(
        `Asset type "${type}" version ${version} was made with a newer engine version (current ${current})`,
      );
    }
    if (!chain || version === current) {
      return { version, payload, migrated: false };
    }
    let next = payload;
    for (let v = version; v < current; v++) {
      next = chain.migrations[v]!(next);
    }
    return { version: current, payload: next, migrated: true };
  }
}

/** Default registry with a placeholder Graph type at v1 (one migration from v0). */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({
    type: "Graph",
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
    migrations: [
      (payload) => ({
        ...payload,
        meshes: Array.isArray(payload.meshes) ? payload.meshes : [],
      }),
    ],
  });
  registry.register({
    type: "Project",
    migrations: [(payload) => ({ ...payload })],
  });
  return registry;
}
