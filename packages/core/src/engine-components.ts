export type EngineComponentPlacement = "world" | "overlay" | "any";

/**
 * The authored surface a component draws: `"2d"` flat in the XY plane as the 2D view shows it (Sprite, Tilemap,
 * Painter and the `2D*` visuals), `"3d"` geometry, or null for none (helpers, lights, cameras, volumes, physics,
 * audio, layout, scripts, and particles, which draw no surface a still capture frames).
 */
export type ComponentSurface = "2d" | "3d";

/**
 * One row per engine ActorComponent class. Derived lists below replace hand-maintained copies. `surface` is required,
 * so a new row states what it draws.
 */
export const ENGINE_COMPONENT_DESCRIPTORS = [
  { classId: "SaveGameComponent", placement: "world", surface: null },
  { classId: "SceneStreamingComponent", placement: "world", surface: null },
  { classId: "LandscapeComponent", placement: "world", surface: "3d" },
  { classId: "FoliageComponent", placement: "world", surface: "3d" },
  { classId: "MeshComponent", placement: "any", surface: "3d" },
  { classId: "DynamicRuntimeMeshComponent", placement: "world", surface: "3d" },
  { classId: "CableComponent", placement: "world", surface: "3d" },
  { classId: "SpriteComponent", placement: "any", surface: "2d" },
  { classId: "TilemapComponent", placement: "any", surface: "2d" },
  { classId: "CameraComponent", placement: "world", surface: null },
  { classId: "RenderTargetCaptureComponent", placement: "world", surface: null },
  { classId: "SpringArmComponent", placement: "world", surface: null },
  { classId: "SplineComponent", placement: "world", surface: "3d" },
  { classId: "LightComponent", placement: "world", surface: null },
  { classId: "AreaRectLightComponent", placement: "world", surface: null },
  { classId: "FogVolumeComponent", placement: "world", surface: null },
  { classId: "MirrorComponent", placement: "world", surface: "3d" },
  { classId: "ReflectionProbeComponent", placement: "world", surface: null },
  { classId: "OutlineComponent", placement: "world", surface: null },
  { classId: "DeformerComponent", placement: "world", surface: null },
  { classId: "HemisphericFillLightComponent", placement: "world", surface: null },
  { classId: "Light2DComponent", placement: "world", surface: null },
  { classId: "SkyboxComponent", placement: "world", surface: "3d" },
  { classId: "Text3DComponent", placement: "any", surface: "3d" },
  { classId: "AudioComponent", placement: "any", surface: null },
  { classId: "ParticleComponent", placement: "any", surface: null },
  { classId: "GlobalWaterVolumeComponent", placement: "world", surface: "3d" },
  { classId: "WaterOceanComponent", placement: "world", surface: "3d" },
  { classId: "WaterLakeComponent", placement: "world", surface: "3d" },
  { classId: "WaterRiverComponent", placement: "world", surface: "3d" },
  { classId: "WaterPuddleComponent", placement: "world", surface: "3d" },
  { classId: "WaterRemovalVolumeComponent", placement: "world", surface: null },
  { classId: "WaterBuoyancyComponent", placement: "world", surface: null },
  { classId: "RigidBodyComponent", placement: "any", surface: null },
  { classId: "MovementComponent", placement: "world", surface: null },
  { classId: "ColliderComponent", placement: "any", surface: null },
  { classId: "PhysicsConstraintComponent", placement: "any", surface: null },
  { classId: "RagdollComponent", placement: "world", surface: null },
  { classId: "AnimationGraphComponent", placement: "any", surface: null },
  { classId: "BehaviourTreeComponent", placement: "any", surface: null },
  { classId: "NavAgentComponent", placement: "any", surface: null },
  { classId: "NavMeshComponent", placement: "any", surface: null },
  { classId: "NavMeshBlockerComponent", placement: "any", surface: null },
  { classId: "BlockingVolumeComponent", placement: "any", surface: null },
  { classId: "2DAnchorComponent", placement: "overlay", surface: null },
  { classId: "2DScrollBoxComponent", placement: "overlay", surface: null },
  { classId: "2DVerticalBoxComponent", placement: "overlay", surface: null },
  { classId: "2DHorizontalBoxComponent", placement: "overlay", surface: null },
  { classId: "2DOverlayBoxComponent", placement: "overlay", surface: null },
  { classId: "2DPaddingComponent", placement: "overlay", surface: null },
  { classId: "2DSpacerComponent", placement: "overlay", surface: null },
  { classId: "2DPainterComponent", placement: "overlay", surface: "2d" },
  { classId: "2DJoystickComponent", placement: "overlay", surface: "2d" },
  { classId: "2DSliderComponent", placement: "overlay", surface: "2d" },
  { classId: "2DRangeSliderComponent", placement: "overlay", surface: "2d" },
  { classId: "2DCheckboxComponent", placement: "overlay", surface: "2d" },
  { classId: "2DRadioButtonComponent", placement: "overlay", surface: "2d" },
  { classId: "2DToggleComponent", placement: "overlay", surface: "2d" },
  { classId: "2DTextInputComponent", placement: "overlay", surface: "2d" },
  { classId: "2DNumericInputComponent", placement: "overlay", surface: "2d" },
  { classId: "2DDropdownComponent", placement: "overlay", surface: "2d" },
  { classId: "2DProgressBarComponent", placement: "overlay", surface: "2d" },
  { classId: "2DVirtualizedListComponent", placement: "overlay", surface: null },
  { classId: "2DVirtualizedGridComponent", placement: "overlay", surface: null },
  { classId: "2DMaskPanelComponent", placement: "overlay", surface: null },
  { classId: "2DMaskComponent", placement: "overlay", surface: null },
  { classId: "2DSafeAreaComponent", placement: "overlay", surface: null },
  { classId: "2DButtonComponent", placement: "overlay", surface: "2d" },
  { classId: "2DFocusTargetComponent", placement: "overlay", surface: null },
  { classId: "2DMaterialComponent", placement: "overlay", surface: "2d" },
  { classId: "2DTextureComponent", placement: "overlay", surface: "2d" },
  { classId: "2DTextComponent", placement: "overlay", surface: "2d" },
  { classId: "2DRichTextComponent", placement: "overlay", surface: "2d" },
  { classId: "2DPanelComponent", placement: "overlay", surface: "2d" },
] as const satisfies readonly {
  readonly classId: string;
  readonly placement: EngineComponentPlacement;
  readonly surface: ComponentSurface | null;
}[];

export type EngineComponentClassId = (typeof ENGINE_COMPONENT_DESCRIPTORS)[number]["classId"];
type DescriptorFor<Placement extends EngineComponentPlacement> = Extract<
  (typeof ENGINE_COMPONENT_DESCRIPTORS)[number],
  { placement: Placement }
>;

/** Engine components with no local transform: their Details show no Transform and no transform getter reads them. */
export const TRANSFORMLESS_COMPONENT_CLASS_IDS: ReadonlySet<EngineComponentClassId> = new Set<EngineComponentClassId>([
  "2DAnchorComponent",
  "MovementComponent",
  "DeformerComponent",
  "SaveGameComponent",
]);

/** Whether an engine component class has a local transform. A user subclass inherits the answer of its engine base. */
export function componentHasTransform(classId: string): boolean {
  return !(TRANSFORMLESS_COMPONENT_CLASS_IDS as ReadonlySet<string>).has(classId);
}

export const ENGINE_COMPONENT_CLASS_IDS: readonly EngineComponentClassId[] =
  ENGINE_COMPONENT_DESCRIPTORS.map((descriptor) => descriptor.classId);
export const SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS: readonly DescriptorFor<"world">["classId"][] =
  ENGINE_COMPONENT_DESCRIPTORS.flatMap((descriptor) => descriptor.placement === "world" ? [descriptor.classId] : []) as DescriptorFor<"world">["classId"][];
export const SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS: readonly DescriptorFor<"overlay">["classId"][] =
  ENGINE_COMPONENT_DESCRIPTORS.flatMap((descriptor) => descriptor.placement === "overlay" ? [descriptor.classId] : []) as DescriptorFor<"overlay">["classId"][];

const SURFACES: ReadonlyMap<string, ComponentSurface | null> = new Map(
  ENGINE_COMPONENT_DESCRIPTORS.map((descriptor) => [descriptor.classId, descriptor.surface]),
);

/** The surface an engine component class draws (`ENGINE_COMPONENT_DESCRIPTORS`); null for none or an unknown class. */
export function componentSurface(classId: string): ComponentSurface | null {
  return SURFACES.get(classId) ?? null;
}
