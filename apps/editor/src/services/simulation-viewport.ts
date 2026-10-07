import type { PlaySceneDocument } from "./play-physics";

/** Only the world Scene panel registers this adapter; asset previews never do. */
export interface SimulationViewport {
  readonly documentId: string;
  readonly host: HTMLElement;
  /** Saves camera state and releases the authoring Scene through its owner. */
  suspend(): Promise<void>;
  /** Reconstructs from the protected authoring document after actual game release. */
  restore(): void;
}

export function simulationSceneDocument(
  documents: readonly PlaySceneDocument[],
  activeDocumentId: string | null,
): PlaySceneDocument | null {
  return documents.find((document) => document.id === activeDocumentId && document.ref.kind === "scene") ??
    documents.find((document) => document.ref.kind === "scene") ?? null;
}
