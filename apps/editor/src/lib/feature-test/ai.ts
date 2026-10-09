import type { SerializedScene } from "@babylonslate/core";
import type { NavMeshGenerateInput } from "@babylonslate/navigation";
import type { FeatureTestContext } from "./context";

// STUB: replaced by the area implementation.
export async function buildFeatureTestAi(_ctx: FeatureTestContext): Promise<void> {}
export async function placeFeatureTestAi(_ctx: FeatureTestContext): Promise<void> {}
export function featureTestNavBakeInput(_scene: SerializedScene): NavMeshGenerateInput | null {
  return null;
}
