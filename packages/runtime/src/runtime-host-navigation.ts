import type { RuntimeNavigation } from "./runtime-navigation";
import type { ScriptHostServices } from "./script-host";

interface NavigationHostDeps {
  navigation(): Pick<RuntimeNavigation, "findPath" | "setAgentTarget" | "stopAgent" |
    "closestNavigablePoint" | "randomPointInRadius" | "addObstacle" | "removeObstacle">;
}

/** Script navigation calls: paths, agent targets, navigable points and dynamic obstacles. */
export function createNavigationHostBindings(deps: NavigationHostDeps): Pick<ScriptHostServices,
  "findPathTo" | "moveTo" | "stopMovement" | "isPathValid" | "getClosestNavigablePoint" |
  "getRandomPointInRadius" | "addObstacle" | "removeObstacle"> {
  return {
    findPathTo: (from, to) => deps.navigation().findPath(from, to),
    moveTo: (actor, destination) => {
      if (!actor) return;
      deps.navigation().setAgentTarget(actor.guid, destination);
    },
    stopMovement: (actor) => {
      if (!actor) return;
      deps.navigation().stopAgent(actor.guid);
    },
    isPathValid: (from, to) => deps.navigation().findPath(from, to).length > 1,
    getClosestNavigablePoint: (point) => deps.navigation().closestNavigablePoint(point),
    getRandomPointInRadius: (center, radius) => deps.navigation().randomPointInRadius(center, radius),
    addObstacle: (kind, pose, size) =>
      deps.navigation().addObstacle(kind === "cylinder" ? "cylinder" : "box", pose, size),
    removeObstacle: (id) => {
      deps.navigation().removeObstacle(id);
    },
  };
}
