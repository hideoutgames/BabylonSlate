import type { SerializedScene } from "@babylonslate/core";
import type { OpenDocument } from "./document-service";

export type SimulationDocumentCommitResult =
  | { ok: true; status: "applied" | "unchanged" }
  | { ok: false; reason: string };

/** Session-owned capability; ordinary authoring commands never receive it. */
export interface SimulationDocumentTransaction {
  readonly baseline: OpenDocument;
  applyScene(scene: SerializedScene): Promise<SimulationDocumentCommitResult>;
  release(): void;
}
