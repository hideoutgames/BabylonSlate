import {
  Color4,
  InputBlock,
  RawTexture,
  Texture,
  TextureBlock,
  type NodeMaterial,
} from "@babylonjs/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type { MaterialBuildPlan } from "@babylonslate/shader-graph";
import type { BlockRealization } from "./material-block-registry";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { markSceneReadinessDirty } from "./scene-perf";

/** Reject invalid writes before replacing a component's replayable value. */
export function validMaterialParameterValue(
  parameter: MaterialParameterValue,
  resolveTexture?: (guid: string) => Texture | null,
): boolean {
  switch (parameter.kind) {
    case "float":
      return Number.isFinite(parameter.value);
    case "color":
      return (
        parameter.value.length === 4 && parameter.value.every(Number.isFinite)
      );
    case "texture": {
      if (!parameter.textureAssetGuid) return true;
      const texture = resolveTexture?.(parameter.textureAssetGuid);
      return (
        !!texture && !texture.isCube && !isDisposedGpuTexture(texture) && !texture.loadingError
      );
    }
  }
}

/** Bind authored parameter names to uniforms and to every sample of a Texture Parameter. */
export function createMaterialParameterBindings(
  plan: MaterialBuildPlan,
  realized: ReadonlyMap<string, BlockRealization>,
  material: NodeMaterial,
  resolveTexture?: (guid: string) => Texture | null,
) {
  const parameters = new Map(
    plan.operations
      .filter(
        (operation) =>
          operation.nodeType.startsWith("param.") &&
          operation.source.callPath.length === 0,
      )
      .map((operation) => [
        String(operation.properties.name ?? "").trim(),
        operation,
      ]),
  );
  const textureObservers = new Map<string, () => void>();
  const copy = (value: MaterialParameterValue): MaterialParameterValue => value.kind === "color"
    ? { kind: "color", value: [...value.value] }
    : { ...value };
  const defaults = new Map<string, MaterialParameterValue>();
  for (const [name, operation] of parameters) {
    const block = realized.get(operation.id)?.blocks[0];
    if (operation.nodeType === "param.texture") {
      defaults.set(name, { kind: "texture", textureAssetGuid:
        typeof operation.properties.textureGuid === "string" ? operation.properties.textureGuid : null });
    } else if (block instanceof InputBlock && operation.nodeType === "param.float") {
      defaults.set(name, { kind: "float", value: block.value as number });
    } else if (block instanceof InputBlock && block.value instanceof Color4) {
      const color = block.value;
      defaults.set(name, { kind: "color", value: [color.r, color.g, color.b, color.a] });
    }
  }
  const values = new Map([...defaults].map(([name, value]) => [name, copy(value)]));
  let emptyTexture: RawTexture | null = null;
  let disposed = false;

  const whiteTexture = (): RawTexture => {
    emptyTexture ??= RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      material.getScene(),
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    return emptyTexture;
  };

  const dirty = (textures = false): void => {
    if (disposed) return;
    const scene = material.getScene();
    // A new texture assignment or its deferred load changes material defines
    // and readiness; reopen the cached strict probe.
    if (textures) markSceneReadinessDirty(scene);
    const blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      material.markDirty(textures);
      // Frozen Play materials must upload changed uniforms on the next bind.
      scene.resetCachedMaterial();
    } finally {
      scene.blockMaterialDirtyMechanism = blocked;
    }
  };

  const bindings = {
    getParameter(name: string): MaterialParameterValue | null {
      const value = !disposed && values.get(name);
      return value ? copy(value) : null;
    },
    resetParameter(name: string): boolean {
      const value = defaults.get(name);
      return !!value && bindings.setParameter(name, value);
    },
    setParameter(name: string, parameter: MaterialParameterValue): boolean {
      if (disposed) return false;
      const operation = parameters.get(name);
      if (
        !operation ||
        operation.nodeType !== `param.${parameter.kind}` ||
        !validMaterialParameterValue(parameter, resolveTexture)
      )
        return false;
      if (parameter.kind === "texture") {
        const texture = parameter.textureAssetGuid
          ? (resolveTexture?.(parameter.textureAssetGuid) ?? null)
          : whiteTexture();
        const block = realized.get(operation.id)?.outputs.out?.ownerBlock as
          { texture?: Texture | null } | undefined;
        if (!block) return false;
        if (block.texture === texture) { values.set(name, copy(parameter)); return true; }
        block.texture = texture;
        textureObservers.get(name)?.();
        textureObservers.delete(name);
        if (texture && texture !== emptyTexture && !texture.isReady()) {
          const observer = texture.onLoadObservable.addOnce(() => dirty(true));
          textureObservers.set(name, () =>
            texture.onLoadObservable.remove(observer),
          );
        }
        dirty(true);
        values.set(name, copy(parameter));
        return true;
      }
      const block = realized.get(operation.id)?.blocks[0];
      if (!(block instanceof InputBlock)) return false;
      if (parameter.kind === "float") {
        block.value = parameter.value;
      } else {
        const [r, g, b, a] = parameter.value;
        block.value = new Color4(r, g, b, a);
      }
      dirty();
      values.set(name, copy(parameter));
      return true;
    },
    dispose(): void {
      disposed = true;
      values.clear();
      defaults.clear();
      for (const remove of textureObservers.values()) remove();
      textureObservers.clear();
      if (emptyTexture) {
        for (const realization of realized.values()) {
          for (const block of realization.blocks) {
            // ImageSourceBlock owns the texture behind connected sample getters.
            if (block instanceof TextureBlock && block.hasImageSource) continue;
            const textured = block as { texture?: Texture | null };
            if (textured.texture === emptyTexture) textured.texture = null;
          }
        }
        emptyTexture.dispose();
        emptyTexture = null;
      }
    },
  };
  return bindings;
}
