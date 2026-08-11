import { serializeTransform } from "@babylonslate/core";
import type { World } from "./world";

export type WorldSnapshot = {
  tickIndex: number;
  dt: number;
  gameInstance: {
    guid: string;
    classId: string;
    variables: Record<string, unknown>;
  } | null;
  actors: Array<{
    guid: string;
    classId: string;
    spawnIndex: number;
    transform: ReturnType<typeof serializeTransform>;
    variables: Record<string, unknown>;
    components: Array<{
      guid: string;
      classId: string;
      assetGuid: string | null;
      variables: Record<string, unknown>;
    }>;
  }>;
};

function sortedVariables(
  variables: Map<string, unknown>,
): Record<string, unknown> {
  const keys = [...variables.keys()].sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = variables.get(key);
  }
  return out;
}

/** Canonical JSON-serializable world state for harness goldens (not P4 bridge). */
export function createWorldSnapshot(world: World): WorldSnapshot {
  const gi = world.gameInstance;
  return {
    tickIndex: world.clock.tickIndex,
    dt: world.clock.dt,
    gameInstance: gi
      ? {
          guid: gi.guid,
          classId: gi.classId,
          variables: sortedVariables(gi.variables),
        }
      : null,
    actors: world.getActors().map((actor) => ({
      guid: actor.guid,
      classId: actor.classId,
      spawnIndex: actor.spawnIndex,
      transform: serializeTransform(actor.transform),
      variables: sortedVariables(actor.variables),
      components: actor.components.map((c) => ({
        guid: c.guid,
        classId: c.classId,
        assetGuid: c.assetGuid,
        variables: sortedVariables(c.variables),
      })),
    })),
  };
}

export function stringifyWorldSnapshot(snapshot: WorldSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
