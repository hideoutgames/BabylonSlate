import type { NullEngine } from "@babylonjs/core";
import { vi } from "vitest";

/**
 * NullEngine keeps raw texture bytes but never marks an upload ready, so a readiness probe that waits on a raw texture
 * (every water surface's terrain and contact fields, for one) never passes. Models the GPU completing each raw upload.
 */
export function completeRawUploads(engine: NullEngine): void {
  const upload = engine.createRawTexture.bind(engine);
  vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => Object.assign(upload(...args), { isReady: true }));
}
