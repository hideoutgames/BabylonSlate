import {
  createDefaultSceneSettings,
  identitySerializedTransform,
} from "@babylonslate/core";

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
 * Scene v1 → v2: the placeholder `meshes[]` list becomes actors carrying a
 * MeshComponent, plus scene settings and a viewport mode default.
 */
function migrateSceneMeshesToActors(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { meshes, ...rest } = payload;
  const legacyMeshes = Array.isArray(meshes) ? meshes : [];
  const actors = legacyMeshes.map((entry, index) => {
    const mesh = (entry ?? {}) as Record<string, unknown>;
    const id = typeof mesh.id === "string" ? mesh.id : `actor-${index + 1}`;
    const position = Array.isArray(mesh.position)
      ? (mesh.position as number[]).slice(0, 3)
      : [0, 0, 0];
    const transform = identitySerializedTransform();
    return {
      id,
      name: id,
      classId: "Actor",
      parentId: null,
      transform: {
        ...transform,
        position: [
          Number(position[0]) || 0,
          Number(position[1]) || 0,
          Number(position[2]) || 0,
        ],
      },
      visible: true,
      locked: false,
      components: [
        {
          id: `${id}-mesh`,
          classId: "MeshComponent",
          properties: {
            meshKind: typeof mesh.type === "string" ? mesh.type : "box",
            assetGuid: null,
          },
        },
      ],
    };
  });

  return {
    ...rest,
    viewportMode: rest.viewportMode === "2d" ? "2d" : "3d",
    settings: rest.settings ?? createDefaultSceneSettings(),
    actors: Array.isArray(rest.actors) ? rest.actors : actors,
  };
}

/** Scene v2 → v3: physicsWorld / editorJoystickEnabled are additive on normalize. */
function migrateSceneV2ToV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload };
}

/** Default registry with Graph/Class logic-graph chains and Scene/Project. */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  const graphMigrations: MigrationFn[] = [
    (payload) => ({
      ...payload,
      nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
      edges: Array.isArray(payload.edges) ? payload.edges : [],
    }),
  ];
  registry.register({
    type: "Graph",
    migrations: graphMigrations,
  });
  registry.register({
    type: "Class",
    migrations: graphMigrations,
  });
  registry.register({
    type: "Scene",
    migrations: [
      (payload) => ({
        ...payload,
        meshes: Array.isArray(payload.meshes) ? payload.meshes : [],
      }),
      migrateSceneMeshesToActors,
      migrateSceneV2ToV3,
    ],
  });
  registry.register({
    type: "Project",
    migrations: [(payload) => ({ ...payload })],
  });
  return registry;
}
