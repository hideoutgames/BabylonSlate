import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ENGINE_BT_BUILTIN_CLASSES } from "@babylonslate/object-model";
import { ENGINE_BASE_CLASSES } from "./content-browser-helpers";

/** Engine class ids indexed as catalog hits (shipped types only; unbuilt P11 nav stays gated). */
export const SEARCH_CATALOG_CLASS_IDS: readonly string[] = [
  ...ENGINE_BASE_CLASSES,
  ...ENGINE_BT_BUILTIN_CLASSES.map((entry) => entry.id),
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "AnimationGraphComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
  "AudioComponent",
  "ParticleComponent",
];

const nodeRegistry = createDefaultNodeRegistry();

/** Graph node type id → palette title, plus the legacy logMessage alias. */
export const SEARCH_NODE_TITLES: Record<string, string> = {
  logMessage: "Log",
};

for (const definition of nodeRegistry.list()) {
  SEARCH_NODE_TITLES[definition.id] = definition.title;
}
