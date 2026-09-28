import { decodeSceneStreamEvent, type SceneStreamIdentity } from "./scene-stream-commands";

export type { SceneStreamIdentity } from "./scene-stream-commands";

interface PendingStream extends SceneStreamIdentity {
  controller: AbortController;
  scheduled: boolean;
}

/** Shared by Play and the packaged player; never changes the parent scene's loading gate. */
export function createSceneStreamingReadiness(options: {
  handle: {
    prepareSceneStream: (slotIds: readonly number[], signal: AbortSignal, onProgress?: (progress: number) => void, owner?: SceneStreamIdentity) => Promise<void>;
  };
  onProgress: (identity: SceneStreamIdentity, progress: number) => void;
  onReady: (identity: SceneStreamIdentity) => void;
  onFailed: (identity: SceneStreamIdentity, error: unknown) => void;
}) {
  const streams = new Map<string, PendingStream>();
  let disposed = false;
  const cancel = (stream: PendingStream) => {
    stream.controller.abort(new Error("Scene streaming was cancelled."));
    streams.delete(stream.actorGuid);
  };
  const current = (stream: PendingStream) => !disposed && streams.get(stream.actorGuid) === stream;
  return {
    receive(command: { type: string; actorGuid?: unknown; streamLoadId?: unknown; slotIds?: unknown }): void {
      if (disposed) return;
      const event = decodeSceneStreamEvent(command);
      if (!event) return;
      if (event.kind === "reset") {
        for (const stream of streams.values()) cancel(stream);
        return;
      }
      const { actorGuid, streamLoadId } = event.identity;
      const stream = streams.get(actorGuid);
      if (event.kind === "loading") {
        if (stream && stream.streamLoadId >= streamLoadId) return;
        if (stream) cancel(stream);
        streams.set(actorGuid, { actorGuid, streamLoadId, controller: new AbortController(), scheduled: false });
        return;
      }
      if (!stream || stream.streamLoadId !== streamLoadId) return;
      if (event.kind === "removed") { cancel(stream); return; }
      if (stream.scheduled) return;
      stream.scheduled = true;
      const pending = stream;
      void (async () => {
        await options.handle.prepareSceneStream(event.slotIds, pending.controller.signal, (progress) => {
          if (current(pending)) options.onProgress(pending, Math.max(0, Math.min(0.99, progress)));
        }, pending);
        if (current(pending)) options.onReady(pending);
      })().catch((error: unknown) => {
        if (!current(pending)) return;
        cancel(pending);
        options.onFailed(pending, error);
      });
    },
    dispose(): void {
      disposed = true;
      for (const stream of streams.values()) cancel(stream);
    },
  };
}
