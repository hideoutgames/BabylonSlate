import { AnimatedInputBlockTypes, InputBlock, type Scene } from "@babylonjs/core";
import { isSceneGameTimePaused, sceneGameTimeNow } from "./scene-game-time";

/** Authored Time uniforms follow the scene clock, including render-only redraws. */
export class GameTimeInputBlock extends InputBlock {
  override animate(scene: Scene): void {
    if (isSceneGameTimePaused(scene)) return;
    if (this.animationType === AnimatedInputBlockTypes.RealTime) {
      this.value = (sceneGameTimeNow(scene) - scene.getEngine().startTime) / 1000;
    } else super.animate(scene);
  }
}
