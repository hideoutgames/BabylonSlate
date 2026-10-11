import { AnimatedInputBlockTypes, InputBlock, NodeMaterialBlockConnectionPointTypes, type Scene } from "@babylonjs/core";
import { isSceneGameTimePaused, sceneGameTimeNow } from "./scene-game-time";

/**
 * Authored Time: elapsed seconds on the scene clock, including render-only redraws.
 * Preview Scenes render independently of the shared Engine's frame loop, so a
 * frame-delta accumulation could be stale.
 */
export class GameTimeInputBlock extends InputBlock {
  constructor(name: string) {
    super(name, undefined, NodeMaterialBlockConnectionPointTypes.Float);
    // Any animation type other than None registers the block for `animate`.
    this.animationType = AnimatedInputBlockTypes.RealTime;
  }

  override animate(scene: Scene): void {
    if (isSceneGameTimePaused(scene)) return;
    this.value = (sceneGameTimeNow(scene) - scene.getEngine().startTime) / 1000;
  }
}
