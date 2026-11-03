import { useEffect, useMemo, useState } from "react";
import {
  parseSpritePayload,
  resolveSpriteAnimation,
  spriteAnimationSheetCellRect,
  spriteAnimationSpriteGuids,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TileRect,
} from "@haptic/assets";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { texturePixelSizeFromHeader } from "../lib/collect-gpu-texture-bytes";

const SPRITE_KINDS = ["sprite"] as const;

/** The Sprites `guids` name: an open Sprite tab's unsaved content, else the saved document. */
export function useSpritePayloads(guids: readonly string[]): ReadonlyMap<string, SpritePayload> {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const openSprites = useOpenDocumentsOfKinds(SPRITE_KINDS);
  const key = guids.join("|");
  const [saved, setSaved] = useState<ReadonlyMap<string, SpritePayload>>(() => new Map());
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (list.length === 0 || !loadAssetDocument) {
      setSaved(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      list.map(async (guid) => {
        const asset = assetRegistry?.getByGuid(guid);
        if (!asset) return null;
        const raw = await loadAssetDocument("sprite", asset.path).catch(() => null);
        return raw && typeof raw === "object" ? ([guid, parseSpritePayload(raw)] as const) : null;
      }),
    ).then((entries) => {
      if (!cancelled) setSaved(new Map(entries.filter((entry) => entry !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, key, loadAssetDocument, registryEpoch]);
  return useMemo(() => {
    void registryEpoch;
    const merged = new Map(saved);
    for (const guid of key ? key.split("|") : []) {
      const asset = assetRegistry?.getByGuid(guid);
      const content = asset ? openSprites.find((doc) => doc.ref.path === asset.path)?.content : undefined;
      if (content && typeof content === "object") merged.set(guid, parseSpritePayload(content));
    }
    return merged;
  }, [assetRegistry, key, openSprites, registryEpoch, saved]);
}

/** What one frame shows: its Texture and the image-space region of it, when the Texture's size is known. */
export interface SpriteAnimationFrameView {
  textureGuid: string;
  /** The Texture's pixel size, from its header. */
  atlas: { width: number; height: number } | null;
  /** The region the frame shows; the whole Texture unless it is a sheet cell. */
  rect: TileRect | null;
}

/**
 * The animation as Play shows it (Sprite frames take their Sprite's Texture,
 * pivot and collision; sheet cells the sheet's Texture and cell size), with
 * each frame's region for the editor preview.
 */
export function useResolvedSpriteAnimation(animation: SpriteAnimationPayload): {
  resolved: SpriteAnimationPayload;
  views: SpriteAnimationFrameView[];
  sheetAtlas: { width: number; height: number } | null;
} {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const spriteGuids = useMemo(() => spriteAnimationSpriteGuids(animation), [animation]);
  const sprites = useSpritePayloads(spriteGuids);
  return useMemo(() => {
    void registryEpoch;
    const textureSize = (guid: string) => (guid ? texturePixelSizeFromHeader(assetRegistry?.getByGuid(guid)) : null);
    const resolved = resolveSpriteAnimation(animation, { sprite: (guid) => sprites.get(guid), textureSize });
    const sheetAtlas = animation.source === "sheet" ? textureSize(animation.sheet.textureGuid) : null;
    const views = resolved.frames.map((frame): SpriteAnimationFrameView => {
      if (animation.source === "sheet") {
        const rect = sheetAtlas ? spriteAnimationSheetCellRect(animation.sheet, sheetAtlas, frame.cell ?? 1) : null;
        return { textureGuid: frame.textureGuid, atlas: sheetAtlas, rect };
      }
      const atlas = textureSize(frame.textureGuid);
      return { textureGuid: frame.textureGuid, atlas, rect: atlas ? { x: 0, y: 0, ...atlas } : null };
    });
    return { resolved, views, sheetAtlas };
  }, [animation, assetRegistry, registryEpoch, sprites]);
}
