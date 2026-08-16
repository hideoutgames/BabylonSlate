/** Canonical type-color maps. CSS values live in `styles/globals.css`. */

export const PIN_COLOR_VAR = {
  exec: "var(--pin-exec)",
  bool: "var(--pin-bool)",
  int: "var(--pin-int)",
  float: "var(--pin-float)",
  string: "var(--pin-string)",
  vector: "var(--pin-vector)",
  rotator: "var(--pin-rotator)",
  transform: "var(--pin-transform)",
  color: "var(--pin-color)",
  object: "var(--pin-object)",
  actor: "var(--pin-actor)",
  class: "var(--pin-class)",
  struct: "var(--pin-struct)",
  enum: "var(--pin-enum)",
  wildcard: "var(--pin-wildcard)",
  delegate: "var(--pin-delegate)",
} as const;

export const PIN_KIND_COLOR_VAR: Record<string, string> = {
  exec: PIN_COLOR_VAR.exec,
  bool: PIN_COLOR_VAR.bool,
  int: PIN_COLOR_VAR.int,
  float: PIN_COLOR_VAR.float,
  string: PIN_COLOR_VAR.string,
  vec2: PIN_COLOR_VAR.vector,
  vec3: PIN_COLOR_VAR.vector,
  vec4: PIN_COLOR_VAR.vector,
  rotator: PIN_COLOR_VAR.rotator,
  transform: PIN_COLOR_VAR.transform,
  color: PIN_COLOR_VAR.color,
  objectRef: PIN_COLOR_VAR.object,
  actorRef: PIN_COLOR_VAR.actor,
  classRef: PIN_COLOR_VAR.class,
  structRef: PIN_COLOR_VAR.struct,
  enumRef: PIN_COLOR_VAR.enum,
  resolvingWildcard: PIN_COLOR_VAR.wildcard,
  boxedWildcard: PIN_COLOR_VAR.wildcard,
  delegate: PIN_COLOR_VAR.delegate,
};

export const PIN_COLOR_TOKENS = [
  "--pin-exec",
  "--pin-bool",
  "--pin-int",
  "--pin-float",
  "--pin-string",
  "--pin-vector",
  "--pin-rotator",
  "--pin-transform",
  "--pin-color",
  "--pin-object",
  "--pin-actor",
  "--pin-class",
  "--pin-struct",
  "--pin-enum",
  "--pin-wildcard",
  "--pin-delegate",
] as const;

export type AssetColorFamily =
  | "scene"
  | "graph"
  | "texture"
  | "material"
  | "model"
  | "audio"
  | "font"
  | "animation"
  | "class"
  | "scriptType"
  | "component"
  | "folder"
  | "unknown";

export const ASSET_COLOR_VAR: Record<AssetColorFamily, string> = {
  scene: "var(--asset-scene)",
  graph: "var(--asset-graph)",
  texture: "var(--asset-texture)",
  material: "var(--asset-material)",
  model: "var(--asset-model)",
  audio: "var(--asset-audio)",
  font: "var(--asset-font)",
  animation: "var(--asset-animation)",
  class: "var(--asset-class)",
  scriptType: "var(--asset-script-type)",
  component: "var(--asset-component)",
  folder: "var(--asset-folder)",
  unknown: "var(--muted-foreground)",
};

export const ASSET_COLOR_TOKENS = [
  "--asset-scene",
  "--asset-graph",
  "--asset-texture",
  "--asset-material",
  "--asset-model",
  "--asset-audio",
  "--asset-font",
  "--asset-animation",
  "--asset-class",
  "--asset-script-type",
  "--asset-component",
  "--asset-folder",
] as const;

export function pinColorVar(kind: string): string {
  return PIN_KIND_COLOR_VAR[kind] ?? PIN_COLOR_VAR.wildcard;
}

export function assetColorVar(family: string): string {
  if (family in ASSET_COLOR_VAR) {
    return ASSET_COLOR_VAR[family as AssetColorFamily];
  }
  return ASSET_COLOR_VAR.unknown;
}

export function typeColorThumbAccent(colorVar: string): {
  border: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
} {
  return {
    border: `2px solid ${colorVar}`,
    borderTopLeftRadius: "calc(var(--radius-xl) - 2px)",
    borderTopRightRadius: "calc(var(--radius-xl) - 2px)",
  };
}
