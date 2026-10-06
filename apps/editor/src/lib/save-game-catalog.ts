import { validateSaveGameDefinition, type SaveGameDefinition } from "@babylonslate/core";

/** Default definition, including unsaved edits in its open asset document. */
export function defaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<{ path: string; header: { guid?: string; type: string; payload?: Record<string, unknown> } }>,
  documents: ReadonlyArray<{ ref: { path?: string; kind: string }; content: unknown }>,
): SaveGameDefinition | undefined {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open?.content ?? asset.header.payload); }
  catch { return undefined; }
}
