import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import {
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_COMPONENT_CLASS_IDS,
} from "@haptic/object-model";
import { ENGINE_BASE_CLASSES } from "./content-browser-helpers";

/** Engine class ids indexed as catalog hits: base classes, built-in BT nodes, SceneLayer and every engine component. */
export const SEARCH_CATALOG_CLASS_IDS: readonly string[] = [
  ...ENGINE_BASE_CLASSES,
  ...ENGINE_BT_BUILTIN_CLASSES.map((entry) => entry.id),
  "SceneLayer",
  ...ENGINE_COMPONENT_CLASS_IDS,
];

const nodeRegistry = createDefaultNodeRegistry();

/** Graph node type id → palette title. */
export const SEARCH_NODE_TITLES: Record<string, string> = {};

for (const definition of nodeRegistry.list()) {
  SEARCH_NODE_TITLES[definition.id] = definition.title;
}
