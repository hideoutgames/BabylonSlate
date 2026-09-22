import {
  LightBlock,
  PBRMetallicRoughnessBlock,
  ShaderLanguage,
  type NodeMaterial,
} from "@babylonjs/core";

/**
 * Babylon 9.20 keeps NodeMaterial's uniform/sampler arrays across light variants.
 * Its light blocks skip sampler additions when vLightData already exists, so a
 * conventional→clustered slot otherwise compiles without the two mask samplers.
 * Wrap only this owner's concrete blocks; never replace a shared prototype.
 */
export function bindClusteredMaterialVariants(
  material: NodeMaterial,
): () => void {
  const restore: Array<() => void> = [];
  for (const block of material.attachedBlocks) {
    if (!(
      block instanceof LightBlock || block instanceof PBRMetallicRoughnessBlock
    ))
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(
      block,
      "updateUniformsAndSamples",
    );
    const original = block.updateUniformsAndSamples;
    const update: typeof original = (
      state,
      nodeMaterial,
      defines,
      uniformBuffers,
    ) => {
      original.call(block, state, nodeMaterial, defines, uniformBuffers);
      for (
        let index = 0;
        index < nodeMaterial.maxSimultaneousLights && defines[`LIGHT${index}`];
        index++
      ) {
        if (!defines[`CLUSTLIGHT${index}`]) continue;
        const names = [`lightDataTexture${index}`];
        // WGSL binds the mask via the tileMaskBuffer{X} storage buffer that
        // lightUboDeclaration emits; only GLSL needs the sampler pair.
        if (nodeMaterial.shaderLanguage === ShaderLanguage.GLSL)
          names.push(`tileMaskTexture${index}`);
        for (const name of names) {
          if (!state.samplers.includes(name)) state.samplers.push(name);
        }
      }
    };
    block.updateUniformsAndSamples = update;
    restore.push(() => {
      if (block.updateUniformsAndSamples !== update) return;
      if (descriptor)
        Object.defineProperty(block, "updateUniformsAndSamples", descriptor);
      else Reflect.deleteProperty(block, "updateUniformsAndSamples");
    });
  }
  return () => {
    for (const action of restore) action();
  };
}
