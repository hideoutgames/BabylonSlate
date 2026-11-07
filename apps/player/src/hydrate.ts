import {
  createPackedContentCache,
  packedContentFromGame as packContent,
  packedSourceControls as sourceControls,
  type GameSourceContent,
  type PackedGameContent,
} from "@haptic/exporter";

export { packedBootControls, type PackedGameContent } from "@haptic/exporter";

/**
 * The player never changes a loaded payload in place, so its source refreshes
 * reuse each Material's normalized document and lowering while it stays loaded.
 */
const cache = createPackedContentCache();

export function packedContentFromGame(game: GameSourceContent): PackedGameContent {
  return packContent(game, cache);
}

export function packedSourceControls(game: GameSourceContent, content?: PackedGameContent) {
  return sourceControls(game, content, cache);
}
