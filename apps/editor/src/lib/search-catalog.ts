import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import {
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_COMPONENT_CLASS_IDS,
} from "@haptic/object-model";
import { ENGINE_BASE_CLASSES } from "./class-asset-lookup";

/** Engine class ids indexed as catalog hits: base classes, built-in BT nodes, SceneLayer and every engine component. */
export const SEARCH_CATALOG_CLASS_IDS: readonly string[] = [
  ...ENGINE_BASE_CLASSES,
  ...ENGINE_BT_BUILTIN_CLASSES.map((entry) => entry.id),
  "SceneLayer",
  ...ENGINE_COMPONENT_CLASS_IDS,
];

let nodeTitles: Readonly<Record<string, string>> | undefined;

/** Graph node type id → palette title, built from the default node registry on first use. */
export function searchNodeTitles(): Readonly<Record<string, string>> {
  if (!nodeTitles) {
    const titles: Record<string, string> = {};
    for (const definition of createDefaultNodeRegistry().list()) titles[definition.id] = definition.title;
    nodeTitles = titles;
  }
  return nodeTitles;
}
