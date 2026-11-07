/**
 * Scenes a Full check walks, in order; the heaviest runs last. A project holding all of them is a Feature Test
 * project, which the editor checks on every open, so this list stays apart from the check's runner.
 */
export const FEATURE_TEST_CHECK_SCENES = [
  { name: "main", path: "assets/main.scene.hasset" },
  { name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset" },
  { name: "FT_Lights", path: "assets/FeatureTest/Scenes/FT_Lights.scene.hasset" },
  { name: "FT_Occlusion", path: "assets/FeatureTest/Scenes/FT_Occlusion.scene.hasset" },
  { name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.hasset" },
  { name: "FT_Stress", path: "assets/FeatureTest/Scenes/FT_Stress.scene.hasset" },
] as const;
