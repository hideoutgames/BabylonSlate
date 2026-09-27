export interface SceneStreamIdentity {
  actorGuid: string;
  streamLoadId: number;
}

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
      if (command.type === "sceneLoading" || command.type === "activeScene") {
        for (const stream of streams.values()) cancel(stream);
        return;
      }
      if (!["sceneStreamLoading", "sceneStreamRealized", "sceneStreamRemoved"].includes(command.type)) return;
      const { actorGuid, streamLoadId } = command;
      if (typeof actorGuid !== "string" || typeof streamLoadId !== "number" || !Number.isSafeInteger(streamLoadId) || streamLoadId < 1) return;
      const stream = streams.get(actorGuid);
      if (command.type === "sceneStreamLoading") {
        if (stream && stream.streamLoadId >= streamLoadId) return;
        if (stream) cancel(stream);
        streams.set(actorGuid, { actorGuid, streamLoadId, controller: new AbortController(), scheduled: false });
        return;
      }
      if (!stream || stream.streamLoadId !== streamLoadId) return;
      if (command.type === "sceneStreamRemoved") { cancel(stream); return; }
      if (stream.scheduled || !Array.isArray(command.slotIds) || !command.slotIds.every((slot) => Number.isSafeInteger(slot) && slot >= 0)) return;
      stream.scheduled = true;
      const pending = stream;
      void (async () => {
        await options.handle.prepareSceneStream(command.slotIds as number[], pending.controller.signal, (progress) => {
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
