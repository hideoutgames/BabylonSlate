import { validateSaveGameDefinition, type SaveGameDefinition } from "@babylonslate/core";

type SaveAsset = { path: string; header: { guid?: string; type: string; payload?: Record<string, unknown> } };
type SaveDocument = { ref: { path?: string; kind: string }; content: unknown };

/** Default definition, including unsaved edits in its open asset document. */
export function defaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
): SaveGameDefinition | undefined {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open?.content ?? asset.header.payload); }
  catch { return undefined; }
}

/** Registry headers omit document chunks; closed definitions must be loaded. */
export async function loadDefaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
  loadAssetDocument: (kind: "save-game", path: string) => Promise<unknown>,
): Promise<SaveGameDefinition | undefined> {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open ? open.content : await loadAssetDocument("save-game", asset.path)); }
  catch { return undefined; }
}
