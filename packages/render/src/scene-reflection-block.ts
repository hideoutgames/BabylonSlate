import {
  NodeMaterialBlockConnectionPointTypes,
  ReflectionBlock,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
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

  override handleFragmentSideInits(state: NodeMaterialBuildState): void {
    // Babylon emits this block's sampler declarations here. WebGPU requires
    // every declared binding, including samplers used only by an inactive branch.
    state._samplerDeclaration += "#ifdef REFLECTION\n";
    super.handleFragmentSideInits(state);
    state._samplerDeclaration += "#endif\n";
  }

  override handleFragmentSideCodeReflectionCoords(
    state: NodeMaterialBuildState,
    worldNormalVarName: string,
    worldPos?: string,
    onlyReflectionVector = false,
    doNotEmitInvertZ = false,
  ): string {
    // Babylon emits computeReflectionCoordsPBR even without REFLECTION, but
    // declares its returned vector only under texture mapping defines. Keep
    // that unused function valid before assignment and after texture removal.
    const coordinates = super.handleFragmentSideCodeReflectionCoords(
      state,
      worldNormalVarName,
      worldPos,
      onlyReflectionVector,
      doNotEmitInvertZ,
    );
    return `#ifdef REFLECTION
${coordinates}
#else
${state._declareLocalVar(this._reflectionVectorName, NodeMaterialBlockConnectionPointTypes.Vector3)} = vec3${state.fSuffix}(0.0);
#endif
`;
  }
}
RegisterClass("BABYLON.SceneReflectionBlock", SceneReflectionBlock);
