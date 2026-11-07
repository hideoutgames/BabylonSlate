import type { EncodeQueue } from "@haptic/assets";
import { onTestFinished } from "vitest";
import { holdEncodeQueuePause } from "../services/encode-queue-pause";
import type { ProjectService } from "../services/project-service";

/**
 * The project's Texture encode queue, which ProjectService keeps private:
 * tests enqueue on it, spy on it and wait for its depth to drain.
 */
export function textureEncodeQueue(service: ProjectService): EncodeQueue {
  return (service as unknown as { textures: { queue: EncodeQueue } }).textures.queue;
}

/**
 * Pause `service`'s Texture encodes through the shared `encode-queue-pause.ts`
 * with a scoped hold, as blocking Scene loads do (Play, Preview Build and a
 * hidden page set named reasons instead), until the returned resume runs.
 * Starts the service's provider-lifetime resources, which subscribe it to the
 * shared pause, and disposes them when the test ends.
 */
export function pauseTextureEncodes(service: ProjectService): () => void {
  service.initialize();
  const resume = holdEncodeQueuePause("test");
  // A failing test never leaves a later test's encodes paused.
  onTestFinished(() => {
    resume();
    service.dispose();
  });
  return resume;
}
