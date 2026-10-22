import { allNodeDefinitions } from "@haptic/scripting-nodes";
import { MATERIAL_CATALOG } from "@haptic/shader-graph";
import { PARTICLE_CATALOG } from "@haptic/particle-graph";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
} from "@haptic/behaviour-tree";

/** Class graph nodes that only exist in Animation Graph event and rule graphs. */
export function scriptGraphFolder(id: string): "animation" | "class" {
  return /^anim\.(event|rule|state)\./.test(id) ? "animation" : "class";
}

/** Every catalog node as `<graph folder>/<node id>`, the key node pages use. */
export function catalogNodeKeys(): string[] {
  return [
    ...allNodeDefinitions().map((def) => `${scriptGraphFolder(def.id)}/${def.id}`),
    ...MATERIAL_CATALOG.map((def) => `material/${def.type}`),
    ...PARTICLE_CATALOG.map((def) => `particle/${def.type}`),
    ...[...BT_COMPOSITE_CATALOG, ...BT_TASK_CATALOG, ...BT_DECORATOR_CATALOG, ...BT_SERVICE_CATALOG].map(
      (entry) => `behaviour-tree/${entry.classId}`,
    ),
  ];
}
