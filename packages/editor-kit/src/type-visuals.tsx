import type { LucideIcon } from "lucide-react";
import {
  AppWindowIcon,
  BoxIcon,
  BoxesIcon,
  BracesIcon,
  CameraIcon,
  CircleDashedIcon,
  CylinderIcon,
  FileIcon,
  FileJsonIcon,
  FilmIcon,
  HexagonIcon,
  ImageIcon,
  ImagesIcon,
  LayersIcon,
  LightbulbIcon,
  ListIcon,
  PaintbrushIcon,
  PersonStandingIcon,
  PlugIcon,
  TypeIcon,
  Volume2Icon,
} from "lucide-react";
import { cn } from "@babylonslate/ui/lib/utils";

export type AssetVisualFamily =
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
  | "unknown";

export type TypeVisual = {
  family: AssetVisualFamily;
  colorVar: string;
  icon: LucideIcon;
  iconKey: string;
};

export type TypeVisualQuery = {
  assetType?: string;
  classId?: string;
  parentClass?: string | null;
  /** Most-specific first. */
  ancestry?: string[];
  family?: AssetVisualFamily;
};

const OBJECT_ICON = HexagonIcon;
const ACTOR_ICON = PersonStandingIcon;
const WIDGET_ICON = AppWindowIcon;

const ENGINE_PARENT: Record<string, string | null> = {
  BObject: null,
  Actor: "BObject",
  ActorComponent: "BObject",
  GameInstance: "BObject",
  FunctionLibrary: "BObject",
  BDebugCommand: "BObject",
  MeshComponent: "ActorComponent",
  SpriteComponent: "ActorComponent",
  TilemapComponent: "ActorComponent",
  CameraComponent: "ActorComponent",
  LightComponent: "ActorComponent",
  AudioComponent: "ActorComponent",
  RigidBodyComponent: "ActorComponent",
  ColliderComponent: "ActorComponent",
  WidgetComponent: "ActorComponent",
  AnimationGraphComponent: "ActorComponent",
  BehaviourTreeComponent: "ActorComponent",
  NavAgentComponent: "ActorComponent",
};

const ICON_BY_ID: Record<string, LucideIcon> = {
  BObject: OBJECT_ICON,
  GameInstance: OBJECT_ICON,
  FunctionLibrary: OBJECT_ICON,
  BDebugCommand: OBJECT_ICON,
  ActorComponent: OBJECT_ICON,
  Actor: ACTOR_ICON,
  WidgetComponent: WIDGET_ICON,
  AnimationGraphComponent: FilmIcon,
  MeshComponent: BoxIcon,
  SpriteComponent: ImagesIcon,
  CameraComponent: CameraIcon,
  LightComponent: LightbulbIcon,
  AudioComponent: Volume2Icon,
  RigidBodyComponent: CylinderIcon,
  ColliderComponent: CircleDashedIcon,
  Scene: LayersIcon,
  Graph: FileJsonIcon,
  Texture: ImageIcon,
  Material: PaintbrushIcon,
  Model: BoxesIcon,
  Audio: Volume2Icon,
  Font: TypeIcon,
  Animation: FilmIcon,
  AnimationGraph: FilmIcon,
  Shader: PaintbrushIcon,
  Sprite: ImagesIcon,
  UserInterface: WIDGET_ICON,
  Class: OBJECT_ICON,
  Enum: ListIcon,
  Structure: BracesIcon,
  ScriptInterface: PlugIcon,
};

const COMPONENT_CLASS_IDS = new Set([
  "MeshComponent",
  "SpriteComponent",
  "CameraComponent",
  "LightComponent",
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "WidgetComponent",
  "AnimationGraphComponent",
]);

const FAMILY_BY_ASSET_TYPE: Record<string, AssetVisualFamily> = {
  Scene: "scene",
  Graph: "graph",
  Texture: "texture",
  Material: "material",
  Model: "model",
  Audio: "audio",
  Font: "font",
  Animation: "animation",
  AnimationGraph: "animation",
  Shader: "material",
  Sprite: "texture",
  UserInterface: "graph",
  Class: "class",
  Enum: "scriptType",
  Structure: "scriptType",
  ScriptInterface: "scriptType",
};

const COLOR_BY_FAMILY: Record<AssetVisualFamily, string> = {
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
] as const;

export function engineParentOf(classId: string): string | null | undefined {
  if (classId in ENGINE_PARENT) return ENGINE_PARENT[classId];
  return undefined;
}

export function walkAncestry(
  start: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): string[] {
  const chain: string[] = [];
  let current = start ?? null;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = parentOf(current) ?? null;
  }
  return chain;
}

function candidateIds(query: TypeVisualQuery): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of query.ancestry ?? []) push(id);
  push(query.classId);
  let parent = query.classId ? engineParentOf(query.classId) : undefined;
  while (parent) {
    push(parent);
    parent = engineParentOf(parent);
  }
  push(query.parentClass);
  push(query.assetType);
  return ids;
}

function iconIdFor(query: TypeVisualQuery): string | undefined {
  return candidateIds(query).find((id) => id in ICON_BY_ID);
}

function familyFor(query: TypeVisualQuery, iconId: string | undefined): AssetVisualFamily {
  if (query.family) return query.family;
  if (query.assetType) {
    return FAMILY_BY_ASSET_TYPE[query.assetType] ?? "unknown";
  }
  if (iconId && COMPONENT_CLASS_IDS.has(iconId)) return "component";
  if (iconId && iconId in ENGINE_PARENT) return "class";
  return "unknown";
}

export function resolveTypeVisual(query: TypeVisualQuery = {}): TypeVisual {
  const iconId = iconIdFor(query);
  const family = familyFor(query, iconId);
  return {
    family,
    colorVar: COLOR_BY_FAMILY[family],
    icon: iconId ? ICON_BY_ID[iconId]! : FileIcon,
    iconKey: iconId ?? "File",
  };
}

export function resolveActorTypeVisual(actor: {
  classId?: string;
  components?: Array<{ classId: string }>;
  ancestry?: string[];
}): TypeVisual {
  const classId = actor.classId ?? "Actor";
  const ancestry =
    actor.ancestry ??
    walkAncestry(classId, (id) => engineParentOf(id) ?? null);
  const engineId = ancestry.find((id) => id in ICON_BY_ID);

  if (classId === "Actor" && engineId === "Actor") {
    const hint = actor.components?.find((component) =>
      COMPONENT_CLASS_IDS.has(component.classId),
    )?.classId;
    if (hint) {
      return resolveTypeVisual({ classId: hint, family: "class" });
    }
  }

  return resolveTypeVisual({
    classId,
    ancestry,
    family: "class",
  });
}

export function TypeVisualIcon({
  visual,
  className,
  "data-testid": testId,
}: {
  visual: TypeVisual;
  className?: string;
  "data-testid"?: string;
}) {
  const Icon = visual.icon;
  return (
    <Icon
      className={cn("size-4 shrink-0", className)}
      style={{ color: visual.colorVar }}
      data-testid={testId}
      data-type-family={visual.family}
      data-type-icon={visual.iconKey}
      aria-hidden
    />
  );
}
