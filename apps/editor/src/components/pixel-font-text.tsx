import { useMemo, type CSSProperties } from "react";
import { rasterizePixelFontLine } from "@haptic/render";
import { cn } from "@haptic/ui/lib/utils";
import { pixelFontLineRgba, pixelPreviewTexelSize } from "../lib/pixel-font-preview";

/** A data URL of `rgba` as a PNG; null without a 2D canvas. */
function rgbaDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string | null {
  if (typeof document === "undefined" || typeof ImageData === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * A line of pixel-font text drawn as 2D Text draws it (native size, every pixel drawn or empty), scaled so each
 * font pixel is the same whole block of device pixels, in the current text colour. Without a 2D canvas it falls
 * back to plain text at the scaled size.
 */
export function PixelFontText({
  text,
  stack,
  pixelSize,
  scale,
  ready,
  className,
  "data-testid": testId,
}: {
  text: string;
  stack: string;
  pixelSize: number;
  scale: number;
  /** Redraws once the Font's face has loaded. */
  ready: boolean;
  className?: string;
  "data-testid"?: string;
}) {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const texel = pixelPreviewTexelSize(scale, ratio);
  const image = useMemo(() => {
    // `ready` redraws with the loaded face instead of its fallback.
    void ready;
    if (!text) return null;
    try {
      const line = rasterizePixelFontLine(text, stack, pixelSize);
      if (!line) return null;
      const { width, height, rgba } = pixelFontLineRgba(line, texel);
      const url = rgbaDataUrl(width, height, rgba);
      return url ? { url, width, height } : null;
    } catch {
      // A line past the allocation limit shows as plain text.
      return null;
    }
  }, [text, stack, pixelSize, texel, ready]);
  if (!image) {
    return (
      <span className={className} data-testid={testId} data-pixel-preview="text" style={{ fontFamily: stack, fontSize: pixelSize * scale }}>
        {text}
      </span>
    );
  }
  const mask = `url(${image.url})`;
  const style: CSSProperties = {
    width: image.width / ratio,
    height: image.height / ratio,
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: "100% 100%",
    WebkitMaskSize: "100% 100%",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
  return (
    <span
      role="img"
      aria-label={text}
      className={cn("inline-block shrink-0 bg-current", className)}
      data-testid={testId}
      data-pixel-preview="image"
      data-pixel-texel={texel}
      style={style}
    />
  );
}
