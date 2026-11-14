import { useMemo, type CSSProperties } from "react";
import type { AnimClipLayer, AnimEvalState } from "@haptic/anim-graph";
import { parseSpriteAnimationPayload, spriteAnimationDurationMs, spriteAnimationPlayhead } from "@haptic/assets";
import { useRegistryState } from "../context/document-context";
import { useResolvedSpriteAnimation } from "./sprite-animation-sources";
import { CHECKERBOARD, FrameImage } from "./sprite-frame-image";
import { useTexturePreviews } from "./texture-preview-status";

/** The heaviest frame layer: frames never blend, so a preview shows one, as Play does. */
function heaviestSpriteLayer(layers: readonly AnimClipLayer[]): AnimClipLayer | undefined {
  return layers
    .filter((layer) => layer.clipKind === "sprite")
    .reduce<AnimClipLayer | undefined>((best, layer) => (!best || layer.weight > best.weight ? layer : best), undefined);
}

/**
 * A 2D animation preview's view: the frame an evaluation shows (its heaviest Sprite Animation layer at its time),
 * flipped as the graph flips it, on a checkerboard. Reports the frame index and flips as data attributes.
 */
export function AnimSpriteFrameView({ state, "data-testid": testId }: { state: AnimEvalState | null; "data-testid"?: string }) {
  const { assetRegistry } = useRegistryState();
  const layer = state ? heaviestSpriteLayer(state.layers) : undefined;
  const asset = layer ? assetRegistry?.getByGuid(layer.clipAssetGuid) : undefined;
  const animation = useMemo(
    () => parseSpriteAnimationPayload(asset?.header.type === "SpriteAnimation" ? asset.header.payload : {}),
    [asset],
  );
  const { resolved, views } = useResolvedSpriteAnimation(animation);
  const index = layer && animation.frames.length > 0
    ? spriteAnimationPlayhead(animation, layer.normalisedTime * spriteAnimationDurationMs(animation), false).index
    : -1;
  const view = index >= 0 ? views[index] : undefined;
  const frame = index >= 0 ? resolved.frames[index] : undefined;
  const textureKey = [...new Set(views.map((entry) => entry.textureGuid).filter(Boolean))].join("|");
  const textureGuids = useMemo(() => (textureKey ? textureKey.split("|") : []), [textureKey]);
  const previewFor = useTexturePreviews(textureGuids);
  const url = previewFor(view?.textureGuid).url;
  const width = view?.rect?.width ?? frame?.width ?? 1;
  const height = view?.rect?.height ?? frame?.height ?? 1;
  const flip: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
    transform: `scale(${layer?.flipX ? -1 : 1}, ${layer?.flipY ? -1 : 1})`,
  };
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      style={{ backgroundImage: CHECKERBOARD, backgroundSize: "16px 16px" }}
      data-testid={testId}
      data-clip={layer?.clipAssetGuid ?? ""}
      data-frame-index={String(index)}
      data-flip-x={layer?.flipX ? "true" : "false"}
      data-flip-y={layer?.flipY ? "true" : "false"}
    >
      {url ? (
        <div className="relative max-h-full max-w-full" style={{ ...flip, height: "100%" }}>
          <FrameImage url={url} view={view} />
        </div>
      ) : null}
    </div>
  );
}
