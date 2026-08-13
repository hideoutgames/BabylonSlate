/** Other dirty scene tabs that must be saved or discarded before opening `nextSceneId`. */
export function dirtyScenesBlockingOpen(
  documents: ReadonlyArray<{
    id: string;
    dirty: boolean;
    ref: { kind: string };
  }>,
  nextSceneId: string,
): typeof documents {
  return documents.filter(
    (doc) =>
      doc.dirty && doc.ref.kind === "scene" && doc.id !== nextSceneId,
  );
}
