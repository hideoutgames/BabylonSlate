import type { ParticleUpdateKernel, ParticleUpdateKernels } from "./particle-update-compiler";

const compiled = new Map<string, ParticleUpdateKernel>();

/**
 * Editor Play's kernels: each compiled from its source with `new Function` once per key, so a changed graph runs at
 * full speed at once. Exported games never include this module; they find the same kernels in their scripts module.
 */
export const functionParticleUpdateKernels: ParticleUpdateKernels = {
  kernel(key, source) {
    let kernel = compiled.get(key);
    if (!kernel) {
      kernel = new Function(`"use strict";\nreturn ${source()};`)() as ParticleUpdateKernel;
      compiled.set(key, kernel);
    }
    return kernel;
  },
};
