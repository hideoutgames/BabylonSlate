import { documentId } from "@babylonslate/core";
import type { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import { applyTextureUsageChange, TextureUsageChangedError } from "./asset-settings";

/** A Usage change `setTextureUsage` made; its Undo sets `previousUsage` back the same way. */
export interface TextureUsageChange {
  previousUsage: string;
  /** Why the open Texture tab that took the edit could not be saved. */
  saveError?: string;
}

export interface TextureUsageChangeHost {
  projectService: Pick<ProjectService, "registry" | "saveDocument" | "setTextureUsage">;
  documentService: Pick<DocumentService, "getState" | "markAllClean">;
  /** Why the Texture cannot change (`textureUsageBlockedReason`); null when it can. */
  blockedReason: (guid: string) => string | null;
  /** The open tab's undoable edit (`DocumentContext.applyAssetDocumentChange`). */
  applyAssetDocumentChange: (id: string, next: Record<string, unknown>) => Promise<boolean>;
  retryTextureEncoding: (guid: string, options: { force: true; usage: string }) => Promise<boolean>;
  /** Runs after the open tab is saved, as Save All does (external-change snapshot). */
  afterTabSave?: () => Promise<void>;
}

/**
 * Texture Details' Usage change made from outside the Texture tab, saved at
 * once. An open tab takes it as an undoable edit and is then saved, with any
 * other pending edits it holds; a closed Texture is saved directly
 * (`ProjectService.setTextureUsage`). Either way it re-encodes when the change
 * affects the encode. Null when the Texture is missing or already uses
 * `usage`; rejects with the reason when it is blocked (nothing changes) or a
 * closed Texture cannot be read or saved. An open tab that took the edit but
 * could not be saved keeps it and reports `saveError`. With `expectedUsage`
 * (an Undo), a Texture whose Usage (open tab, else file) is neither `usage`
 * nor `expectedUsage` is left alone: rejects with `TextureUsageChangedError`.
 */
export async function changeTextureUsage(
  host: TextureUsageChangeHost,
  guid: string,
  usage: string,
  expectedUsage?: string,
): Promise<TextureUsageChange | null> {
  const asset = host.projectService.registry?.getByGuid(guid);
  if (!asset || asset.header.type !== "Texture") return null;
  const blocked = host.blockedReason(guid);
  if (blocked) throw new Error(blocked);
  const id = documentId({ kind: "texture", path: asset.path });
  const open = host.documentService.getState().openDocuments.get(id);
  if (!open?.content) return host.projectService.setTextureUsage(guid, usage, expectedUsage);

  const content = open.content as Record<string, unknown>;
  const previousUsage = String(content.usage ?? "albedo");
  if (previousUsage === usage) return null;
  if (expectedUsage !== undefined && previousUsage !== expectedUsage) {
    throw new TextureUsageChangedError(previousUsage);
  }
  const { payload, shouldRequeue } = applyTextureUsageChange(content, usage);
  if (!(await host.applyAssetDocumentChange(id, payload))) return null;
  let saveError: string | undefined;
  try {
    await saveOpenTexture(host, id);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }
  if (shouldRequeue) await host.retryTextureEncoding(guid, { force: true, usage });
  return saveError ? { previousUsage, saveError } : { previousUsage };
}

/** Save one open Texture tab as Save All would, clean unless edited meanwhile. */
async function saveOpenTexture(host: TextureUsageChangeHost, id: string): Promise<void> {
  const doc = host.documentService.getState().openDocuments.get(id);
  if (!doc?.content) return;
  // The edit stored a copy of the payload: snapshot the tab's own content.
  const snapshot = { ...doc };
  await host.projectService.saveDocument(
    "texture",
    snapshot.ref.path,
    snapshot.content as Record<string, unknown>,
  );
  host.documentService.markAllClean([snapshot]);
  await host.afterTabSave?.();
}
