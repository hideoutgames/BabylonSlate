export type EngineComponentPlacement = "world" | "overlay" | "any";

/** One row per engine ActorComponent class. Derived lists below replace hand-maintained copies. */
export const ENGINE_COMPONENT_DESCRIPTORS = [
  { classId: "SceneStreamingComponent", placement: "world" },
  { classId: "LandscapeComponent", placement: "world" },
  { classId: "FoliageComponent", placement: "world" },
  { classId: "MeshComponent", placement: "any" },
  { classId: "SpriteComponent", placement: "any" },
  { classId: "TilemapComponent", placement: "any" },
  { classId: "CameraComponent", placement: "world" },
  { classId: "RenderTargetCaptureComponent", placement: "world" },
  { classId: "SpringArmComponent", placement: "world" },
  { classId: "SplineComponent", placement: "world" },
  { classId: "LightComponent", placement: "world" },
  { classId: "AreaRectLightComponent", placement: "world" },
  { classId: "FogVolumeComponent", placement: "world" },
  { classId: "OutlineComponent", placement: "world" },
  { classId: "HemisphericFillLightComponent", placement: "world" },
  { classId: "SkyboxComponent", placement: "world" },
  { classId: "Text3DComponent", placement: "any" },
  { classId: "AudioComponent", placement: "any" },
  { classId: "ParticleComponent", placement: "any" },
  { classId: "GlobalWaterVolumeComponent", placement: "world" },
  { classId: "WaterOceanComponent", placement: "world" },
  { classId: "WaterLakeComponent", placement: "world" },
  { classId: "WaterRiverComponent", placement: "world" },
  { classId: "WaterPuddleComponent", placement: "world" },
  { classId: "WaterRemovalVolumeComponent", placement: "world" },
  { classId: "WaterBuoyancyComponent", placement: "world" },
  { classId: "RigidBodyComponent", placement: "any" },
  { classId: "ColliderComponent", placement: "any" },
  { classId: "PhysicsConstraintComponent", placement: "any" },
  { classId: "RagdollComponent", placement: "world" },
  { classId: "AnimationGraphComponent", placement: "any" },
  { classId: "BehaviourTreeComponent", placement: "any" },
  { classId: "NavAgentComponent", placement: "any" },
  { classId: "NavMeshComponent", placement: "any" },
  { classId: "NavMeshBlockerComponent", placement: "any" },
  { classId: "BlockingVolumeComponent", placement: "any" },
  { classId: "2DAnchorComponent", placement: "overlay" },
  { classId: "2DButtonComponent", placement: "overlay" },
  { classId: "2DMaterialComponent", placement: "overlay" },
  { classId: "2DTextureComponent", placement: "overlay" },
  { classId: "2DTextComponent", placement: "overlay" },
  { classId: "2DRichTextComponent", placement: "overlay" },
  { classId: "2DPanelComponent", placement: "overlay" },
] as const satisfies readonly { readonly classId: string; readonly placement: EngineComponentPlacement }[];

export type EngineComponentClassId = (typeof ENGINE_COMPONENT_DESCRIPTORS)[number]["classId"];
type DescriptorFor<Placement extends EngineComponentPlacement> = Extract<
  (typeof ENGINE_COMPONENT_DESCRIPTORS)[number],
  { placement: Placement }
>;

export const ENGINE_COMPONENT_CLASS_IDS: readonly EngineComponentClassId[] =
  ENGINE_COMPONENT_DESCRIPTORS.map((descriptor) => descriptor.classId);
export const SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS: readonly DescriptorFor<"world">["classId"][] =
  ENGINE_COMPONENT_DESCRIPTORS.flatMap((descriptor) => descriptor.placement === "world" ? [descriptor.classId] : []) as DescriptorFor<"world">["classId"][];
export const SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS: readonly DescriptorFor<"overlay">["classId"][] =
  ENGINE_COMPONENT_DESCRIPTORS.flatMap((descriptor) => descriptor.placement === "overlay" ? [descriptor.classId] : []) as DescriptorFor<"overlay">["classId"][];

export function engineComponentPlacement(classId: string): EngineComponentPlacement | undefined {
  return ENGINE_COMPONENT_DESCRIPTORS.find((descriptor) => descriptor.classId === classId)?.placement;
}
