import { act } from "@testing-library/react";
import { dispatchPointerEvent, type PointerInit } from "./pointer-events";

/**
 * Tap (or click, with `pointerType: "mouse"`) one tile of an `AtlasTileGrid`
 * as a pointer would: the grid draws its tiles on a canvas and hit-tests the
 * press by column and row, so tests press its surface at the tile's centre.
 * jsdom lays nothing out, so the atlas image is placed at the client origin at
 * its own pixel size first. `tile` is the tile size; the sheet has no margin
 * or spacing.
 */
export function tapAtlasTile(
  testId: string,
  tileId: number,
  tile: { width: number; height: number } = { width: 16, height: 16 },
  init: PointerInit = {},
): void {
  const image = document.querySelector<HTMLElement>(`[data-testid="${testId}-image"]`);
  const surface = document.querySelector<HTMLElement>(`[data-testid="${testId}-surface"]`);
  if (!image || !surface) throw new Error(`No atlas tile grid "${testId}".`);
  const width = Number.parseFloat(image.style.width) || tile.width;
  const height = Number.parseFloat(image.style.height) || tile.height;
  image.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const columns = Math.max(1, Math.floor(width / tile.width));
  const clientX = ((tileId - 1) % columns) * tile.width + tile.width / 2;
  const clientY = Math.floor((tileId - 1) / columns) * tile.height + tile.height / 2;
  const pointer = { pointerId: 91, ...init, clientX, clientY };
  act(() => {
    dispatchPointerEvent(surface, "pointerdown", pointer);
    dispatchPointerEvent(surface, "pointerup", pointer);
  });
}
