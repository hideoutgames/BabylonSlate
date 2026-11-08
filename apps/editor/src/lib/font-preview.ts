import { compileFontStack } from "@haptic/assets";

/** Size the drawing comparison paints at: large enough that two faces of similar shape still differ. */
const COMPARE_SIZE = 32;
let compareCanvas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null | undefined;

function compareContext(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (compareCanvas !== undefined) return compareCanvas;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = COMPARE_SIZE * 3;
  canvas.height = COMPARE_SIZE * 2;
  // Read back on every comparison: keep it a software canvas.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  compareCanvas = ctx ? { canvas, ctx } : null;
  return compareCanvas;
}

function paintedAlpha(text: string, stack: string): Uint8ClampedArray | null {
  const target = compareContext();
  if (!target) return null;
  const { canvas, ctx } = target;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${COMPARE_SIZE}px ${stack}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";
  ctx.fillText(text, COMPARE_SIZE / 2, COMPARE_SIZE * 1.5);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Whether `text` paints exactly the same pixels in two font stacks; null without a 2D canvas. */
export function textDrawsSame(text: string, stackA: string, stackB: string): boolean | null {
  const a = paintedAlpha(text, stackA);
  // The next paint reuses the canvas, so keep a copy of the first.
  const first = a ? new Uint8ClampedArray(a) : null;
  const second = first ? paintedAlpha(text, stackB) : null;
  if (!first || !second || first.length !== second.length) return null;
  for (let index = 3; index < first.length; index += 4) if (first[index] !== second[index]) return false;
  return true;
}

export function familyFromAssetPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const family = (payload as { family?: unknown }).family;
  return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
}

export function fontEditorStack(options: {
  family: string;
  fallbackGuids: readonly string[];
  defaultFontGuid: string | null;
  globalFallback: string;
  familyForGuid: (guid: string) => string | null;
}): string {
  const fallbackFamilies = options.fallbackGuids
    .map((guid) => options.familyForGuid(guid))
    .filter((family): family is string => family !== null);
  return compileFontStack({
    family: options.family,
    fallbackFamilies,
    projectDefaultFamily: options.defaultFontGuid
      ? options.familyForGuid(options.defaultFontGuid)
      : null,
    globalFallback: options.globalFallback,
  });
}
