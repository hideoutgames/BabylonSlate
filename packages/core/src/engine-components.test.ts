import { describe, expect, it } from "vitest";
import { componentSurface, ENGINE_COMPONENT_CLASS_IDS } from "./engine-components";

// Hand-written: what each engine component draws decides a Class thumbnail's 2D or 3D view and which actors a
// capture frames. Every descriptor must state it (the descriptor type requires `surface`); this table pins the answer.
const FLAT = [
  "SpriteComponent", "TilemapComponent", "2DPainterComponent", "2DTextureComponent", "2DMaterialComponent",
  "2DPanelComponent", "2DButtonComponent", "2DTextComponent", "2DRichTextComponent", "2DJoystickComponent",
  "2DSliderComponent", "2DRangeSliderComponent", "2DCheckboxComponent", "2DRadioButtonComponent", "2DToggleComponent",
  "2DTextInputComponent", "2DNumericInputComponent", "2DDropdownComponent", "2DProgressBarComponent",
];
const GEOMETRY = [
  "MeshComponent", "DynamicRuntimeMeshComponent", "Text3DComponent", "LandscapeComponent", "FoliageComponent",
  "CableComponent", "SplineComponent", "MirrorComponent", "SkyboxComponent", "GlobalWaterVolumeComponent",
  "WaterOceanComponent", "WaterLakeComponent", "WaterRiverComponent", "WaterPuddleComponent",
];

describe("componentSurface", () => {
  it.each(FLAT)("%s draws a 2D surface", (classId) => {
    expect(componentSurface(classId)).toBe("2d");
  });

  it.each(GEOMETRY)("%s draws 3D geometry", (classId) => {
    expect(componentSurface(classId)).toBe("3d");
  });

  it("draws nothing for helpers, lights, physics, audio, layout, decals, particles and unknown classes", () => {
    for (const classId of [
      "ColliderComponent", "RigidBodyComponent", "AudioComponent", "MovementComponent", "CameraComponent",
      "LightComponent", "Light2DComponent", "ParticleComponent", "WaterRemovalVolumeComponent", "FogVolumeComponent",
      "2DAnchorComponent", "2DVerticalBoxComponent", "2DMaskPanelComponent", "2DFocusTargetComponent",
      "BehaviourTreeComponent", "DecalComponent", "2DPostProcessingPanelComponent", "MyScriptComponent",
    ]) {
      expect(componentSurface(classId), classId).toBeNull();
    }
  });

  it("classifies only engine components, every drawn one listed above", () => {
    const drawn = ENGINE_COMPONENT_CLASS_IDS.filter((classId) => componentSurface(classId) !== null);
    expect([...drawn].sort()).toEqual([...FLAT, ...GEOMETRY].sort());
  });
});
