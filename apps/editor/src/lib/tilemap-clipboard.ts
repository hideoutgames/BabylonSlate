import type { TilemapClip } from "@haptic/assets";

/**
 * The tiles Tilemap Paint's Cut and Copy keep: one block for the editor
 * session, shared by every Tilemap document (Paste re-numbers it for the map
 * it lands in with `retargetTilemapClip`). Never the system clipboard.
 */
let copied: TilemapClip | null = null;
const listeners = new Set<() => void>();

export const tilemapClipboard = {
  read: (): TilemapClip | null => copied,
  write(clip: TilemapClip | null): void {
    if (clip === copied) return;
    copied = clip;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
