import { useMemo, useState, type CSSProperties } from "react";
import type { AnimClipLayer, AnimEvalState } from "@haptic/anim-graph";
import {
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  spriteAnimationPlayhead,
  spriteAnimationSpriteGuids,
} from "@haptic/assets";
import { useRegistryState } from "../context/document-context";
import { resolveSpriteAnimationViews, useSpritePayloads, type SpriteAnimationFrameView } from "./sprite-animation-sources";
import { CHECKERBOARD, FrameImage } from "./sprite-frame-image";
import { useTexturePreviews } from "./texture-preview-status";

/** The heaviest frame layer: frames never blend, so a preview shows one, as Play does. */
function heaviestSpriteLayer(layers: readonly AnimClipLayer[]): AnimClipLayer | undefined {
  return layers
    .filter((layer) => layer.clipKind === "sprite")
    .reduce<AnimClipLayer | undefined>((best, layer) => (!best || layer.weight > best.weight ? layer : best), undefined);
}

/** `values` without duplicates or blanks, sorted, so a list that holds the same guids keeps one key. */
function guidKey(values: Iterable<string>): string {
  return [...new Set([...values].filter(Boolean))].sort().join("|");
}

function splitKey(key: string): string[] {
  return key ? key.split("|") : [];
}

type ShownFrame = { url: string; view: SpriteAnimationFrameView | undefined; width: number; height: number };

/** What a shown frame draws, by value: a frame resolved again draws the same. */
function shownFrameKey(frame: ShownFrame): string {
  const { rect, atlas } = frame.view ?? {};
  return [frame.url, rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "", atlas ? `${atlas.width}x${atlas.height}` : "", frame.width, frame.height].join("|");
}

/**
 * A 2D animation preview's view: the frame an evaluation shows (its heaviest Sprite Animation layer at its time),
 * flipped as the graph flips it, on a checkerboard. Reports the frame index and flips as data attributes.
 *
 * It loads the Textures of `spriteAnimationGuids` (every Sprite Animation the preview can play) and of each one it
 * has shown up front, so switching to another shows its frame at once; while a frame's Texture is still loading it
 * keeps the last frame it showed.
 */
export function AnimSpriteFrameView({
  state,
  spriteAnimationGuids,
  "data-testid": testId,
}: {
  state: AnimEvalState | null;
  spriteAnimationGuids?: readonly string[];
  "data-testid"?: string;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const layer = state ? heaviestSpriteLayer(state.layers) : undefined;
  const current = layer?.clipAssetGuid ?? "";

  // Each Sprite Animation shown stays loaded, so switching back to it is instant too.
  const [shownGuids, setShownGuids] = useState<readonly string[]>([]);
  if (current && !shownGuids.includes(current)) setShownGuids([...shownGuids, current]);
  const animationKey = guidKey([...(spriteAnimationGuids ?? []), ...shownGuids, current]);

  const animations = useMemo(() => {
    void registryEpoch;
    return new Map(
      splitKey(animationKey).map((guid) => {
        const asset = assetRegistry?.getByGuid(guid);
        return [guid, parseSpriteAnimationPayload(asset?.header.type === "SpriteAnimation" ? asset.header.payload : {})] as const;
      }),
    );
  }, [animationKey, assetRegistry, registryEpoch]);
  const spriteKey = guidKey([...animations.values()].flatMap((animation) => spriteAnimationSpriteGuids(animation)));
  const spriteGuids = useMemo(() => splitKey(spriteKey), [spriteKey]);
  const sprites = useSpritePayloads(spriteGuids);
  const resolvedByGuid = useMemo(() => {
    void registryEpoch;
    return new Map([...animations].map(([guid, animation]) => [guid, resolveSpriteAnimationViews(animation, sprites, assetRegistry)] as const));
  }, [animations, assetRegistry, registryEpoch, sprites]);
  const textureKey = guidKey([...resolvedByGuid.values()].flatMap((entry) => entry.views.map((view) => view.textureGuid)));
  const textureGuids = useMemo(() => splitKey(textureKey), [textureKey]);
  const previewFor = useTexturePreviews(textureGuids);

  const animation = animations.get(current);
  const resolved = resolvedByGuid.get(current);
  const index = layer && animation && animation.frames.length > 0
    ? spriteAnimationPlayhead(animation, layer.normalisedTime * spriteAnimationDurationMs(animation), false).index
    : -1;
  const view = index >= 0 ? resolved?.views[index] : undefined;
  const frame = index >= 0 ? resolved?.resolved.frames[index] : undefined;
  const preview = previewFor(view?.textureGuid);
  const width = view?.rect?.width ?? frame?.width ?? 1;
  const height = view?.rect?.height ?? frame?.height ?? 1;

  // The last frame shown, which stays up while the next one's Texture loads instead of a blank view.
  const [lastShown, setLastShown] = useState<ShownFrame | null>(null);
  const currentFrame: ShownFrame | null = preview.url ? { url: preview.url, view, width, height } : null;
  if (currentFrame && (!lastShown || shownFrameKey(lastShown) !== shownFrameKey(currentFrame))) setLastShown(currentFrame);
  const shown = currentFrame ?? (preview.status === "loading" ? lastShown : null);

  const flip: CSSProperties | undefined = shown
    ? {
        aspectRatio: `${shown.width} / ${shown.height}`,
        transform: `scale(${layer?.flipX ? -1 : 1}, ${layer?.flipY ? -1 : 1})`,
      }
    : undefined;
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      style={{ backgroundImage: CHECKERBOARD, backgroundSize: "16px 16px" }}
      data-testid={testId}
      data-clip={current}
      data-frame-index={String(index)}
      data-frame-loading={preview.url || preview.status !== "loading" ? "false" : "true"}
      data-flip-x={layer?.flipX ? "true" : "false"}
      data-flip-y={layer?.flipY ? "true" : "false"}
    >
      {shown ? (
        <div className="relative max-h-full max-w-full" style={{ ...flip, height: "100%" }}>
          <FrameImage url={shown.url} view={shown.view} />
        </div>
      ) : null}
    </div>
  );
}
