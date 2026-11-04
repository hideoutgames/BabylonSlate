import { useEffect, useRef, type RefObject } from "react";
import type { SerializedScene } from "@haptic/core";
import type { EngineHandle } from "@haptic/render";
import { useRegistryState } from "../context/document-context";
import { tilemapAssetGuidsFromScene } from "../lib/play-content";
import { openDocumentPayloadRevision } from "../lib/scene-viewport-assets";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

const TILEMAP_KINDS = ["tilemap"] as const;

/**
 * Show edits of the Tilemaps the Scene draws in its viewport as they are made,
 * not when they are saved: each open Tilemap document the Scene references is
 * handed to the viewport (`EngineHandle.setLiveTilemap`) once per frame
 * whatever number of edits land in it, and the viewport rebuilds only the
 * chunk meshes that changed. A Tilemap tab that closes is handed back;
 * `onDiscarded` runs when it closed with unsaved edits, so the viewport loads
 * the saved map again.
 */
export function useLiveTilemapEdits({
  scene,
  engineRef,
  onDiscarded,
}: {
  scene: SerializedScene | null;
  engineRef: RefObject<EngineHandle | null>;
  onDiscarded: () => void;
}): void {
  const documents = useOpenDocumentsOfKinds(TILEMAP_KINDS);
  const { assetRegistry, registryEpoch } = useRegistryState();
  /** What each Tilemap was last handed to the viewport as, and whether it had unsaved edits then. */
  const sentRef = useRef(new Map<string, { content: object; dirty: boolean; handle: EngineHandle }>());
  const frameRef = useRef<number | null>(null);
  const onDiscardedRef = useRef(onDiscarded);
  onDiscardedRef.current = onDiscarded;

  useEffect(() => {
    void registryEpoch;
    const referenced = new Set(tilemapAssetGuidsFromScene(scene));
    const open = new Map<string, { content: object; dirty: boolean }>();
    for (const doc of documents) {
      const guid = assetRegistry?.getByPath?.(doc.ref.path)?.header.guid;
      if (guid && referenced.has(guid) && doc.content && typeof doc.content === "object") {
        open.set(guid, { content: doc.content, dirty: doc.dirty });
      }
    }
    const send = () => {
      frameRef.current = null;
      const handle = engineRef.current;
      const sent = sentRef.current;
      let discarded = false;
      for (const [guid, was] of sent) {
        if (open.has(guid) && was.handle === handle) continue;
        sent.delete(guid);
        if (was.handle === handle) {
          was.handle.setLiveTilemap(guid, null);
          discarded ||= was.dirty;
        }
      }
      if (handle) {
        for (const [guid, entry] of open) {
          const was = sent.get(guid);
          if (was?.content === entry.content) {
            was.dirty = entry.dirty;
            continue;
          }
          handle.setLiveTilemap(guid, entry.content, openDocumentPayloadRevision(entry.content));
          sent.set(guid, { ...entry, handle });
        }
      }
      if (discarded) onDiscardedRef.current();
    };
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (typeof requestAnimationFrame === "function") frameRef.current = requestAnimationFrame(send);
    else send();
  }, [assetRegistry, documents, engineRef, registryEpoch, scene]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);
}
