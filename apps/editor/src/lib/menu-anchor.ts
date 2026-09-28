/** Viewport point just below a trigger button, for popup menu `anchor` props. */
export function anchorBelow(button: Element): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}
