import { ReflectionBlock } from "@babylonjs/core";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Keep optional scene IBL bindable when a graph builds before asset collection. */
export class SceneReflectionBlock extends ReflectionBlock {
  override getClassName(): string {
    return "SceneReflectionBlock";
  }

  // Babylon 9.20 PBRMetallicRoughnessBlock uses this getter to decide whether
  // to emit reflection code at build time. Scene environments arrive later.
  // Emit the optional branch from the start; native prepareDefines/isReady/bind
  // still inspect the actual texture and disable it while none is admitted.
  override get hasTexture(): boolean {
    return true;
  }
}
RegisterClass("BABYLON.SceneReflectionBlock", SceneReflectionBlock);
