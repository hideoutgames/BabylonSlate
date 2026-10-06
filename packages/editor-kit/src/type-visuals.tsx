import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  AnchorIcon,
  ArrowDownUpIcon,
  BoxIcon,
  BoxesIcon,
  BracesIcon,
  CableIcon,
  CameraIcon,
  CircleDashedIcon,
  CloudIcon,
  Columns3Icon,
  CylinderIcon,
  FileBoxIcon,
  FileBracesCornerIcon,
  FileAxis3dIcon,
  FileCogIcon,
  FileIcon,
  FileJsonIcon,
  FileSlidersIcon,
  FileSpreadsheetIcon,
  FileStackIcon,
  FileTerminalIcon,
  FilmIcon,
  FocusIcon,
  Grid3x3Icon,
  Gamepad2Icon,
  ImageIcon,
  ImagesIcon,
  Layers2Icon,
  LayersIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  ListTreeIcon,
  MapIcon,
  MountainIcon,
  MousePointerClickIcon,
  NavigationIcon,
  NetworkIcon,
  PaintbrushIcon,
  PersonStandingIcon,
  PlugIcon,
  PuzzleIcon,
  Rows3Icon,
  SpaceIcon,
  SparklesIcon,
  SplineIcon,
  SquareDashedIcon,
  TreesIcon,
  TypeIcon,
  Volume2Icon,
  WindIcon,
  WavesIcon,
  WaypointsIcon,
  EraserIcon,
  WorkflowIcon,
} from "lucide-react";
import { ENGINE_COMPONENT_CLASS_IDS } from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import { assetColorVar } from "@babylonslate/ui/lib/data-types";

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
  | "struct"
  | "component"
  | "folder"
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

const OBJECT_ICON = FileIcon;
const ACTOR_ICON = FileBoxIcon;

const ENGINE_PARENT: Record<string, string | null> = {
  BObject: null,
  MaterialObject: "BObject",
  Actor: "BObject",
  RenderTargetCapture: "Actor",
  Scene: "BObject",
  SceneLayer: "BObject",
  SceneLayerActor: "Actor",
  SceneLayerActorSwitcher: "SceneLayerActor",
  SceneStreamingActor: "Actor",
  ActorComponent: "BObject",
  GameInstance: "BObject",
  // Hidden abstract base: never offered, but subsystem ancestry walks it.
  Subsystem: "BObject",
  GameSubsystem: "Subsystem",
  SceneSubsystem: "Subsystem",
  FunctionLibrary: "BObject",
  BDebugCommand: "BObject",
  EditorUtilityObject: "BObject",
  EditorFunctionLibrary: "FunctionLibrary",
  BTTask: "BObject",
  BTDecorator: "BObject",
  BTService: "BObject",
  BTComposite: "BObject",
  BTTask_Wait: "BTTask",
  BTTask_MoveTo: "BTTask",
  BTTask_MoveToBlackboardKey: "BTTask",
  BTTask_RotateToFace: "BTTask",
  BTTask_PlayAnimation: "BTTask",
  BTTask_PlaySound: "BTTask",
  BTTask_SetBlackboardValue: "BTTask",
  BTDecorator_Loop: "BTDecorator",
  BTDecorator_Cooldown: "BTDecorator",
  BTDecorator_TimeLimit: "BTDecorator",
  BTDecorator_BlackboardIsSet: "BTDecorator",
  BTDecorator_CompareBlackboardValue: "BTDecorator",
  BTService_SetBlackboardValue: "BTService",
  BTComposite_Selector: "BTComposite",
  BTComposite_Sequence: "BTComposite",
  BTComposite_Parallel: "BTComposite",
  LandscapeComponent: "ActorComponent",
  FoliageComponent: "ActorComponent",
  MeshComponent: "ActorComponent",
  DynamicRuntimeMeshComponent: "ActorComponent",
  SpriteComponent: "ActorComponent",
  TilemapComponent: "ActorComponent",
  CameraComponent: "ActorComponent",
  RenderTargetCaptureComponent: "ActorComponent",
  SpringArmComponent: "ActorComponent",
  CableComponent: "ActorComponent",
  SplineComponent: "ActorComponent",
  LightComponent: "ActorComponent",
  AreaRectLightComponent: "ActorComponent",
  FogVolumeComponent: "ActorComponent",
  OutlineComponent: "ActorComponent",
  DeformerComponent: "ActorComponent",
  HemisphericFillLightComponent: "ActorComponent",
  SkyboxComponent: "ActorComponent",
  Text3DComponent: "ActorComponent",
  SceneStreamingComponent: "ActorComponent",
  AudioComponent: "ActorComponent",
  ParticleComponent: "ActorComponent",
  GlobalWaterVolumeComponent: "ActorComponent",
  WaterOceanComponent: "ActorComponent",
  WaterLakeComponent: "ActorComponent",
  WaterRiverComponent: "ActorComponent",
  WaterPuddleComponent: "ActorComponent",
  WaterRemovalVolumeComponent: "ActorComponent",
  WaterBuoyancyComponent: "ActorComponent",
  RigidBodyComponent: "ActorComponent",
  MovementComponent: "ActorComponent",
  ColliderComponent: "ActorComponent",
  PhysicsConstraintComponent: "ActorComponent",
  RagdollComponent: "ActorComponent",
  AnimationGraphComponent: "ActorComponent",
  BehaviourTreeComponent: "ActorComponent",
  NavAgentComponent: "ActorComponent",
  NavMeshComponent: "ActorComponent",
  NavMeshBlockerComponent: "ActorComponent",
  BlockingVolumeComponent: "ActorComponent",
  "2DAnchorComponent": "ActorComponent",
  "2DScrollBoxComponent": "ActorComponent",
  "2DVerticalBoxComponent": "ActorComponent",
  "2DHorizontalBoxComponent": "ActorComponent",
  "2DOverlayBoxComponent": "ActorComponent",
  "2DPaddingComponent": "ActorComponent",
  "2DSpacerComponent": "ActorComponent",
  "2DVirtualizedListComponent": "ActorComponent",
  "2DVirtualizedGridComponent": "ActorComponent",
  "2DMaskPanelComponent": "ActorComponent",
  "2DMaskComponent": "ActorComponent",
  "2DSafeAreaComponent": "ActorComponent",
  "2DSliderComponent": "ActorComponent",
  "2DRangeSliderComponent": "ActorComponent",
  "2DCheckboxComponent": "ActorComponent",
  "2DRadioButtonComponent": "ActorComponent",
  "2DToggleComponent": "ActorComponent",
  "2DTextInputComponent": "ActorComponent",
  "2DNumericInputComponent": "ActorComponent",
  "2DDropdownComponent": "ActorComponent",
  "2DProgressBarComponent": "ActorComponent",
  "2DJoystickComponent": "ActorComponent",
  "2DPainterComponent": "ActorComponent",
  "2DButtonComponent": "ActorComponent",
  "2DFocusTargetComponent": "ActorComponent",
  "2DMaterialComponent": "ActorComponent",
  "2DTextureComponent": "ActorComponent",
  "2DTextComponent": "ActorComponent",
  "2DRichTextComponent": "ActorComponent",
  "2DPanelComponent": "ActorComponent",
};

const ICON_BY_ID: Record<string, LucideIcon> = {
  BObject: OBJECT_ICON,
  MaterialObject: PaintbrushIcon,
  GameInstance: FileSlidersIcon,
  GameSubsystem: FileStackIcon,
  SceneSubsystem: FileAxis3dIcon,
  FunctionLibrary: FileSpreadsheetIcon,
  BDebugCommand: FileTerminalIcon,
  EditorUtilityObject: FileBracesCornerIcon,
  EditorFunctionLibrary: FileSpreadsheetIcon,
  BTTask: OBJECT_ICON,
  BTDecorator: OBJECT_ICON,
  BTService: OBJECT_ICON,
  BTComposite: OBJECT_ICON,
  ActorComponent: FileCogIcon,
  Actor: ACTOR_ICON,
  SceneLayer: Layers2Icon,
  SceneLayerActor: ACTOR_ICON,
  SceneLayerActorSwitcher: Layers2Icon,
  SceneStreamingActor: LayersIcon,
  AnimationGraphComponent: WorkflowIcon,
  BehaviourTreeComponent: ListTreeIcon,
  NavAgentComponent: NavigationIcon,
  NavMeshComponent: MapIcon,
  NavMeshBlockerComponent: BoxIcon,
  BlockingVolumeComponent: SquareDashedIcon,
  "2DAnchorComponent": AnchorIcon,
  "2DScrollBoxComponent": ArrowDownUpIcon,
  "2DVerticalBoxComponent": Rows3Icon,
  "2DHorizontalBoxComponent": Columns3Icon,
  "2DOverlayBoxComponent": Layers2Icon,
  "2DPaddingComponent": SquareDashedIcon,
  "2DSpacerComponent": SpaceIcon,
  "2DVirtualizedListComponent": Rows3Icon,
  "2DVirtualizedGridComponent": LayoutGridIcon,
  "2DMaskPanelComponent": SquareDashedIcon,
  "2DMaskComponent": SquareDashedIcon,
  "2DSafeAreaComponent": SquareDashedIcon,
  "2DSliderComponent": FileSlidersIcon,
  "2DRangeSliderComponent": FileSlidersIcon,
  "2DCheckboxComponent": MousePointerClickIcon,
  "2DRadioButtonComponent": CircleDashedIcon,
  "2DToggleComponent": MousePointerClickIcon,
  "2DTextInputComponent": TypeIcon,
  "2DNumericInputComponent": FileSlidersIcon,
  "2DDropdownComponent": ListIcon,
  "2DProgressBarComponent": ActivityIcon,
  "2DJoystickComponent": Gamepad2Icon,
  "2DPainterComponent": PaintbrushIcon,
  "2DButtonComponent": MousePointerClickIcon,
  "2DFocusTargetComponent": FocusIcon,
  "2DMaterialComponent": PaintbrushIcon,
  "2DTextureComponent": ImageIcon,
  "2DTextComponent": TypeIcon,
  "2DRichTextComponent": SparklesIcon,
  "2DPanelComponent": LayoutGridIcon,
  LandscapeComponent: MountainIcon,
  FoliageComponent: TreesIcon,
  MeshComponent: BoxIcon,
  DynamicRuntimeMeshComponent: BoxIcon,
  SpriteComponent: ImagesIcon,
  TilemapComponent: Grid3x3Icon,
  CameraComponent: CameraIcon,
  RenderTargetCapture: CameraIcon,
  RenderTargetCaptureComponent: CameraIcon,
  SpringArmComponent: SplineIcon,
  CableComponent: CableIcon,
  SplineComponent: WaypointsIcon,
  LightComponent: LightbulbIcon,
  AreaRectLightComponent: LightbulbIcon,
  FogVolumeComponent: CloudIcon,
  OutlineComponent: SquareDashedIcon,
  DeformerComponent: BoxIcon,
  HemisphericFillLightComponent: LightbulbIcon,
  SkyboxComponent: CloudIcon,
  Text3DComponent: TypeIcon,
  SceneStreamingComponent: LayersIcon,
  AudioComponent: Volume2Icon,
  ParticleComponent: SparklesIcon,
  GlobalWaterVolumeComponent: WavesIcon,
  WaterOceanComponent: WavesIcon,
  WaterLakeComponent: WavesIcon,
  WaterRiverComponent: WavesIcon,
  WaterPuddleComponent: WavesIcon,
  WaterRemovalVolumeComponent: EraserIcon,
  WaterBuoyancyComponent: AnchorIcon,
  RigidBodyComponent: CylinderIcon,
  MovementComponent: NavigationIcon,
  ColliderComponent: CircleDashedIcon,
  PhysicsConstraintComponent: LinkIcon,
  RagdollComponent: PersonStandingIcon,
  Scene: LayersIcon,
  Graph: FileJsonIcon,
  Texture: ImageIcon,
  RenderTarget: CameraIcon,
  RenderTargetTexture: ImageIcon,
  Material: PaintbrushIcon,
  MaterialInstance: PaintbrushIcon,
  MaterialFunction: PaintbrushIcon,
  Model: BoxesIcon,
  Mesh: BoxesIcon,
  Audio: Volume2Icon,
  AudioMixer: Volume2Icon,
  InputAction: MousePointerClickIcon,
  InputAxis: NavigationIcon,
  AudioChannel: Volume2Icon,
  SoundAttenuation: Volume2Icon,
  ParticleEmitter: WindIcon,
  ParticleGraph: NetworkIcon,
  ParticleSystem: SparklesIcon,
  Water: WavesIcon,
  SkyboxCreator: CloudIcon,
  Trace: ActivityIcon,
  Font: TypeIcon,
  Animation: FilmIcon,
  Skeleton: PersonStandingIcon,
  AnimationGraph: WorkflowIcon,
  SpriteAnimation: FilmIcon,
  BehaviourTree: ListTreeIcon,
  Blackboard: ListIcon,
  Shader: PaintbrushIcon,
  Sprite: ImagesIcon,
  Tileset: LayoutGridIcon,
  Tilemap: Grid3x3Icon,
  Class: OBJECT_ICON,
  Enum: ListIcon,
  Structure: BracesIcon,
  DataDefinition: FileBoxIcon,
  DataSheet: FileSpreadsheetIcon,
  ScriptInterface: PlugIcon,
  PluginSettings: PuzzleIcon,
};

const COMPONENT_CLASS_IDS = new Set<string>(ENGINE_COMPONENT_CLASS_IDS);

const FAMILY_BY_ASSET_TYPE: Record<string, AssetVisualFamily> = {
  Scene: "scene",
  SceneLayer: "scene",
  Graph: "graph",
  Texture: "texture",
  RenderTarget: "texture",
  RenderTargetTexture: "texture",
  Material: "material",
  MaterialInstance: "material",
  MaterialFunction: "material",
  Model: "model",
  Mesh: "model",
  Audio: "class",
  AudioMixer: "scene",
  InputAction: "struct",
  InputAxis: "struct",
  AudioChannel: "struct",
  SoundAttenuation: "class",
  ParticleEmitter: "material",
  ParticleGraph: "material",
  ParticleSystem: "material",
  Water: "material",
  SkyboxCreator: "material",
  Trace: "class",
  Font: "font",
  Animation: "animation",
  Skeleton: "animation",
  AnimationGraph: "animation",
  SpriteAnimation: "animation",
  BehaviourTree: "class",
  Blackboard: "struct",
  Shader: "material",
  Sprite: "texture",
  Tileset: "texture",
  Tilemap: "texture",
  Class: "class",
  Enum: "scriptType",
  Structure: "struct",
  DataDefinition: "struct",
  DataSheet: "struct",
  ScriptInterface: "class",
  PluginSettings: "scriptType",
};

const COLOR_BY_FAMILY: Record<AssetVisualFamily, string> = {
  scene: assetColorVar("scene"),
  graph: assetColorVar("graph"),
  texture: assetColorVar("texture"),
  material: assetColorVar("material"),
  model: assetColorVar("model"),
  audio: assetColorVar("audio"),
  font: assetColorVar("font"),
  animation: assetColorVar("animation"),
  class: assetColorVar("animation"),
  scriptType: assetColorVar("scriptType"),
  struct: assetColorVar("class"),
  component: assetColorVar("component"),
  folder: assetColorVar("folder"),
  unknown: assetColorVar("unknown"),
};

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
  if (
    query.classId &&
    !(query.classId in ENGINE_PARENT) &&
    query.ancestry?.includes("ActorComponent")
  ) {
    return "class";
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

export const TYPE_VISUAL_ICON_CHROME_SIZE = 16;
export const TYPE_VISUAL_ICON_TILE_SIZE = 40;
/** Lucide design stroke in CSS px when `absoluteStrokeWidth` is set on tiles. */
export const TYPE_VISUAL_ICON_TILE_STROKE_WIDTH = 2;

export function TypeVisualIcon({
  visual,
  size = TYPE_VISUAL_ICON_CHROME_SIZE,
  className,
  "data-testid": testId,
}: {
  visual: TypeVisual;
  size?: number;
  className?: string;
  "data-testid"?: string;
}) {
  const Icon = visual.icon;
  const isTile = size >= TYPE_VISUAL_ICON_TILE_SIZE;
  const sizeClass = isTile ? "size-10" : "size-4";
  return (
    <Icon
      size={size}
      color={visual.colorVar}
      strokeWidth={TYPE_VISUAL_ICON_TILE_STROKE_WIDTH}
      absoluteStrokeWidth={isTile}
      className={cn(sizeClass, "shrink-0 overflow-visible", className)}
      data-testid={testId}
      data-type-family={visual.family}
      data-type-icon={visual.iconKey}
      aria-hidden
    />
  );
}
