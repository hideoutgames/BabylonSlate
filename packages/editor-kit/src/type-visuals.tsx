import type { ComponentType } from "react";
import { EqualizerIcon } from "@phosphor-icons/react/dist/csr/Equalizer";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import {
  IconAdjustmentsAlt,
  IconCube3dSphere,
  IconDatabase,
  IconEaseInOutControlPoints,
  IconFileMusic,
  IconKeyframes,
  IconListDetails,
  IconMovie,
  IconPackage,
  IconPhoto,
  IconPhotoVideo,
  IconSphere,
  IconSphere2,
  IconTimelineEvent,
} from "@tabler/icons-react";
import {
  ActivityIcon,
  AnchorIcon,
  AtomIcon,
  ApertureIcon,
  ArrowDownUpIcon,
  BoxIcon,
  BracesIcon,
  CableIcon,
  CameraIcon,
  CaseSensitiveIcon,
  ChartScatterIcon,
  CircleDashedIcon,
  ClapperboardIcon,
  ClipboardListIcon,
  CloudIcon,
  CloudSunIcon,
  Columns3Icon,
  CompassIcon,
  CylinderIcon,
  EraserIcon,
  FileAxis3dIcon,
  FileBoxIcon,
  FileBracesCornerIcon,
  FileCogIcon,
  FileIcon,
  FileJsonIcon,
  FileSlidersIcon,
  FileSpreadsheetIcon,
  FileStackIcon,
  FileTerminalIcon,
  FilmIcon,
  FlameIcon,
  FlipHorizontal2Icon,
  FocusIcon,
  Gamepad2Icon,
  Grid3x3Icon,
  HazeIcon,
  ImageIcon,
  ImagePlayIcon,
  ImagesIcon,
  Layers2Icon,
  LayersIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  ListTreeIcon,
  MapPinnedIcon,
  MountainIcon,
  MousePointerClickIcon,
  MoveIcon,
  NetworkIcon,
  PaintbrushIcon,
  PersonStandingIcon,
  PlugIcon,
  RectangleHorizontalIcon,
  Rows3Icon,
  SaveIcon,
  SpaceIcon,
  SparklesIcon,
  SplineIcon,
  SquareDashedIcon,
  SquareFunctionIcon,
  StickerIcon,
  TreesIcon,
  TypeIcon,
  VibrateIcon,
  Volume2Icon,
  WavesIcon,
  WaypointsIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { ENGINE_COMPONENT_CLASS_IDS } from "@haptic/core";
import { cn } from "@haptic/ui/lib/utils";
import { assetColorVar } from "@haptic/ui/lib/data-types";

export type AssetVisualFamily =
  | "scene"
  | "graph"
  | "texture"
  | "renderTarget"
  | "sprite"
  | "material"
  | "materialInstance"
  | "visualEffects"
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

/** The props `TypeVisualIcon` passes. Lucide icons take them as they are; Tabler and Phosphor icons go through `tablerGlyph` / `phosphorGlyph`. */
export type TypeVisualGlyphProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  className?: string;
  "aria-hidden"?: boolean;
  "data-testid"?: string;
  "data-type-family"?: string;
  "data-type-icon"?: string;
};

export type TypeVisualGlyph = ComponentType<TypeVisualGlyphProps> | LucideIcon;

export type TypeVisual = {
  family: AssetVisualFamily;
  colorVar: string;
  icon: TypeVisualGlyph;
  iconKey: string;
  /** What a Class asset reads as in the Content Browser (Actor, Object, Subsystem, ...); other types have none. */
  classKind?: string;
};

/** Lucide's on-screen stroke in px: `absoluteStrokeWidth` holds it at `strokeWidth` px whatever the size. */
function lucideStrokePx({ size = 24, strokeWidth = 2, absoluteStrokeWidth }: TypeVisualGlyphProps): number {
  return absoluteStrokeWidth ? strokeWidth : (strokeWidth * size) / 24;
}

/** A Tabler icon (Lucide's 24-unit grid and 2-unit stroke), stroked as Lucide strokes the same props. */
function tablerGlyph(Icon: typeof IconPhoto): TypeVisualGlyph {
  return function TablerTypeGlyph({ size = 24, strokeWidth = 2, absoluteStrokeWidth, ...rest }: TypeVisualGlyphProps) {
    return <Icon size={size} stroke={absoluteStrokeWidth ? (strokeWidth * 24) / size : strokeWidth} {...rest} />;
  };
}

/** Phosphor weights by stroke width, in units of its 256-unit grid. */
const PHOSPHOR_WEIGHTS = [
  ["light", 12],
  ["regular", 16],
  ["bold", 24],
] as const;

/** A Phosphor icon in the weight whose stroke is closest to Lucide's at that size (bold in chrome, light on tiles). */
function phosphorGlyph(Icon: typeof EqualizerIcon): TypeVisualGlyph {
  return function PhosphorTypeGlyph({ size = 24, strokeWidth, absoluteStrokeWidth, ...rest }: TypeVisualGlyphProps) {
    const target = lucideStrokePx({ size, strokeWidth, absoluteStrokeWidth });
    const off = (units: number) => Math.abs((units * size) / 256 - target);
    const [weight] = PHOSPHOR_WEIGHTS.reduce((best, entry) => (off(entry[1]) < off(best[1]) ? entry : best));
    return <Icon size={size} weight={weight} {...rest} />;
  };
}

const MIXER_GLYPH = tablerGlyph(IconAdjustmentsAlt);
const PHOTO_GLYPH = tablerGlyph(IconPhoto);
const SPHERE_GLYPH = tablerGlyph(IconSphere);
const SPHERE_2_GLYPH = tablerGlyph(IconSphere2);
const MODEL_GLYPH = tablerGlyph(IconCube3dSphere);
const PACKAGE_GLYPH = tablerGlyph(IconPackage);
const MOVIE_GLYPH = tablerGlyph(IconMovie);
const KEYFRAMES_GLYPH = tablerGlyph(IconKeyframes);
const PHOTO_VIDEO_GLYPH = tablerGlyph(IconPhotoVideo);
const FILE_MUSIC_GLYPH = tablerGlyph(IconFileMusic);
const LIST_DETAILS_GLYPH = tablerGlyph(IconListDetails);
const TIMELINE_EVENT_GLYPH = tablerGlyph(IconTimelineEvent);
const DATABASE_GLYPH = tablerGlyph(IconDatabase);
const CURVE_GLYPH = tablerGlyph(IconEaseInOutControlPoints);
const EQUALIZER_GLYPH = phosphorGlyph(EqualizerIcon);
const PUZZLE_GLYPH = phosphorGlyph(PuzzlePieceIcon);
const FLOPPY_GLYPH = phosphorGlyph(FloppyDiskIcon);

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
  Object: null,
  MaterialObject: "Object",
  FloatCurveObject: "Object",
  VectorCurveObject: "Object",
  ColorCurveObject: "Object",
  TimelineClip: "Object",
  Timeline: "Object",
  Actor: "Object",
  RenderTargetCapture: "Actor",
  Scene: "Object",
  SceneLayer: "Object",
  SceneLayerActor: "Actor",
  SceneLayerActorSwitcher: "SceneLayerActor",
  SceneStreamingActor: "Actor",
  ActorComponent: "Object",
  GameInstance: "Object",
  // Hidden abstract base: never offered, but subsystem ancestry walks it.
  Subsystem: "Object",
  GameSubsystem: "Subsystem",
  SceneSubsystem: "Subsystem",
  FunctionLibrary: "Object",
  DebugCommand: "Object",
  EditorUtilityObject: "Object",
  EditorFunctionLibrary: "FunctionLibrary",
  BTTask: "Object",
  BTDecorator: "Object",
  BTService: "Object",
  BTComposite: "Object",
  RichText2DAppearMode: "Object",
  RichText2DDecoratorEffect: "Object",
  CustomEasingCurve: "Object",
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
  SaveGameComponent: "ActorComponent",
  LightComponent: "ActorComponent",
  AreaRectLightComponent: "ActorComponent",
  FogVolumeComponent: "ActorComponent",
  MirrorComponent: "ActorComponent",
  ReflectionProbeComponent: "ActorComponent",
  OutlineComponent: "ActorComponent",
  DeformerComponent: "ActorComponent",
  HemisphericFillLightComponent: "ActorComponent",
  Light2DComponent: "ActorComponent",
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

const ICON_BY_ID: Record<string, TypeVisualGlyph> = {
  Object: OBJECT_ICON,
  MaterialObject: SPHERE_GLYPH,
  GameInstance: FileSlidersIcon,
  GameSubsystem: FileStackIcon,
  SceneSubsystem: FileAxis3dIcon,
  FunctionLibrary: FileSpreadsheetIcon,
  DebugCommand: FileTerminalIcon,
  EditorUtilityObject: FileBracesCornerIcon,
  EditorFunctionLibrary: FileSpreadsheetIcon,
  BTTask: OBJECT_ICON,
  BTDecorator: OBJECT_ICON,
  BTService: OBJECT_ICON,
  BTComposite: OBJECT_ICON,
  RichText2DAppearMode: OBJECT_ICON,
  RichText2DDecoratorEffect: OBJECT_ICON,
  CustomEasingCurve: OBJECT_ICON,
  ActorComponent: FileCogIcon,
  Actor: ACTOR_ICON,
  SceneLayer: Layers2Icon,
  SceneLayerActor: ACTOR_ICON,
  SceneLayerActorSwitcher: Layers2Icon,
  SceneStreamingActor: LayersIcon,
  AnimationGraphComponent: WorkflowIcon,
  BehaviourTreeComponent: ListTreeIcon,
  NavAgentComponent: CompassIcon,
  NavMeshComponent: MapPinnedIcon,
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
  SaveGameComponent: SaveIcon,
  LightComponent: LightbulbIcon,
  AreaRectLightComponent: RectangleHorizontalIcon,
  FogVolumeComponent: CloudIcon,
  MirrorComponent: FlipHorizontal2Icon,
  ReflectionProbeComponent: ApertureIcon,
  OutlineComponent: SquareDashedIcon,
  DeformerComponent: BoxIcon,
  HemisphericFillLightComponent: HazeIcon,
  Light2DComponent: LightbulbIcon,
  SkyboxComponent: CloudSunIcon,
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
  MovementComponent: MoveIcon,
  ColliderComponent: SquareDashedIcon,
  PhysicsConstraintComponent: LinkIcon,
  RagdollComponent: PersonStandingIcon,
  Scene: LayersIcon,
  Graph: FileJsonIcon,
  Texture: PHOTO_GLYPH,
  RenderTarget: CameraIcon,
  RenderTargetTexture: ImageIcon,
  Material: SPHERE_GLYPH,
  MaterialInstance: SPHERE_2_GLYPH,
  MaterialFunction: SquareFunctionIcon,
  Model: MODEL_GLYPH,
  Audio: FILE_MUSIC_GLYPH,
  AudioMixer: MIXER_GLYPH,
  InputAction: Gamepad2Icon,
  InputAxis: MoveIcon,
  AudioChannel: EQUALIZER_GLYPH,
  SoundAttenuation: Volume2Icon,
  CameraShake: VibrateIcon,
  ParticleEmitter: FlameIcon,
  ParticleGraph: NetworkIcon,
  ParticleSystem: AtomIcon,
  Water: WavesIcon,
  SkyboxCreator: CloudSunIcon,
  Trace: TIMELINE_EVENT_GLYPH,
  Font: CaseSensitiveIcon,
  Animation: MOVIE_GLYPH,
  Skeleton: PersonStandingIcon,
  AnimationGraph3D: WorkflowIcon,
  AnimationGraph2D: WorkflowIcon,
  BlendSpace: ChartScatterIcon,
  SpriteBlendSpace: ChartScatterIcon,
  SpriteAnimation: PHOTO_VIDEO_GLYPH,
  // Keyframes over time, so it reads apart from the animation and clip glyphs.
  Timeline: KEYFRAMES_GLYPH,
  TimelineClip2D: ImagePlayIcon,
  TimelineClip3D: ClapperboardIcon,
  BehaviourTree: NetworkIcon,
  Blackboard: ClipboardListIcon,
  SaveGame: FLOPPY_GLYPH,
  Sprite: StickerIcon,
  Tileset: LayoutGridIcon,
  Tilemap: Grid3x3Icon,
  Class: OBJECT_ICON,
  Prefab: PACKAGE_GLYPH,
  Enum: LIST_DETAILS_GLYPH,
  Structure: BracesIcon,
  DataDefinition: FileBoxIcon,
  DataTree: DATABASE_GLYPH,
  FloatCurve: CURVE_GLYPH,
  VectorCurve: CURVE_GLYPH,
  ColorCurve: CURVE_GLYPH,
  GlobalParameterCollection: FileSlidersIcon,
  FloatCurveObject: CURVE_GLYPH,
  VectorCurveObject: CURVE_GLYPH,
  ColorCurveObject: CURVE_GLYPH,
  TimelineClip: FilmIcon,
  ScriptInterface: PlugIcon,
  PluginSettings: PUZZLE_GLYPH,
};

const COMPONENT_CLASS_IDS = new Set<string>(ENGINE_COMPONENT_CLASS_IDS);

const FAMILY_BY_ASSET_TYPE: Record<string, AssetVisualFamily> = {
  Scene: "scene",
  SceneLayer: "scene",
  Graph: "graph",
  Texture: "texture",
  RenderTarget: "renderTarget",
  RenderTargetTexture: "renderTarget",
  Material: "material",
  MaterialInstance: "materialInstance",
  MaterialFunction: "material",
  Model: "model",
  Audio: "class",
  AudioMixer: "scene",
  InputAction: "struct",
  InputAxis: "struct",
  AudioChannel: "struct",
  SoundAttenuation: "class",
  ParticleEmitter: "visualEffects",
  ParticleGraph: "visualEffects",
  ParticleSystem: "visualEffects",
  Water: "material",
  SkyboxCreator: "material",
  Trace: "class",
  Font: "font",
  Animation: "animation",
  Skeleton: "animation",
  AnimationGraph3D: "animation",
  AnimationGraph2D: "sprite",
  BlendSpace: "animation",
  SpriteBlendSpace: "sprite",
  SpriteAnimation: "sprite",
  Timeline: "animation",
  CameraShake: "renderTarget",
  TimelineClip2D: "animation",
  TimelineClip3D: "animation",
  BehaviourTree: "class",
  Blackboard: "struct",
  SaveGame: "struct",
  Sprite: "sprite",
  Tileset: "sprite",
  Tilemap: "sprite",
  Class: "class",
  Prefab: "model",
  Enum: "scriptType",
  Structure: "struct",
  DataDefinition: "struct",
  DataTree: "struct",
  FloatCurve: "struct",
  VectorCurve: "struct",
  ColorCurve: "struct",
  GlobalParameterCollection: "struct",
  ScriptInterface: "class",
  PluginSettings: "scriptType",
};

const COLOR_BY_FAMILY: Record<AssetVisualFamily, string> = {
  scene: assetColorVar("scene"),
  graph: assetColorVar("graph"),
  // Textures share the blue Class assets show.
  texture: assetColorVar("animation"),
  renderTarget: assetColorVar("renderTarget"),
  sprite: assetColorVar("sprite"),
  material: assetColorVar("material"),
  materialInstance: assetColorVar("materialInstance"),
  visualEffects: assetColorVar("visualEffects"),
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

/** A Class's kind by its nearest engine base; a Class with none of these bases reads Object. */
const CLASS_KIND_LABEL: Record<string, string> = {
  Actor: "Actor",
  Subsystem: "Subsystem",
  GameInstance: "Game Instance",
  ActorComponent: "Component",
  FunctionLibrary: "Function Library",
  EditorFunctionLibrary: "Editor Function Library",
  DebugCommand: "Debug Command",
  EditorUtilityObject: "Editor Utility Object",
  BTTask: "Behaviour Tree Task",
  BTDecorator: "Behaviour Tree Decorator",
  BTService: "Behaviour Tree Service",
  BTComposite: "Behaviour Tree Composite",
  RichText2DAppearMode: "Rich Text Appear Mode",
  RichText2DDecoratorEffect: "Rich Text Decorator Effect",
  CustomEasingCurve: "Easing Curve",
};

/** The kind label for a Class ancestry, most specific first. */
function classKindLabel(ancestry: readonly string[]): string {
  for (const id of ancestry) {
    const label = CLASS_KIND_LABEL[id];
    if (label) return label;
  }
  return "Object";
}

export function resolveTypeVisual(query: TypeVisualQuery = {}): TypeVisual {
  const iconId = iconIdFor(query);
  const family = familyFor(query, iconId);
  return {
    family,
    colorVar: COLOR_BY_FAMILY[family],
    icon: iconId ? ICON_BY_ID[iconId]! : FileIcon,
    iconKey: iconId ?? "File",
    ...(query.assetType === "Class"
      ? {
          classKind: classKindLabel(
            query.ancestry?.length
              ? query.ancestry
              : walkAncestry(query.parentClass ?? query.classId ?? "Object", (id) => engineParentOf(id) ?? null),
          ),
        }
      : {}),
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

const TYPE_VISUAL_ICON_CHROME_SIZE = 16;
/** A multiple of Lucide's 24-unit grid, so whole and half units land on whole pixels. */
export const TYPE_VISUAL_ICON_TILE_SIZE = 48;
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
  const sizeClass = isTile ? "size-12" : "size-4";
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
