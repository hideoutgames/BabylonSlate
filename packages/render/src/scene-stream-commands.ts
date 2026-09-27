export interface SceneStreamIdentity {
  actorGuid: string;
  streamLoadId: number;
}

export type SceneStreamEvent =
  | { kind: "reset" }
  | { kind: "loading"; identity: SceneStreamIdentity }
  | { kind: "realized"; identity: SceneStreamIdentity; slotIds: readonly number[] }
  | { kind: "removed"; identity: SceneStreamIdentity };

/** One validation point for every consumer; unrelated or malformed commands decode to null. */
export function decodeSceneStreamEvent(command: {
  type: string;
  actorGuid?: unknown;
  streamLoadId?: unknown;
  slotIds?: unknown;
}): SceneStreamEvent | null {
  if (command.type === "sceneLoading" || command.type === "activeScene") return { kind: "reset" };
  if (command.type !== "sceneStreamLoading" && command.type !== "sceneStreamRealized" && command.type !== "sceneStreamRemoved") return null;
  if (typeof command.actorGuid !== "string" || typeof command.streamLoadId !== "number" ||
      !Number.isSafeInteger(command.streamLoadId) || command.streamLoadId < 1) return null;
  const identity = { actorGuid: command.actorGuid, streamLoadId: command.streamLoadId };
  if (command.type === "sceneStreamLoading") return { kind: "loading", identity };
  if (command.type === "sceneStreamRemoved") return { kind: "removed", identity };
  if (!Array.isArray(command.slotIds) || !command.slotIds.every((slot: unknown) =>
    typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0)) return null;
  return { kind: "realized", identity, slotIds: command.slotIds as number[] };
}
