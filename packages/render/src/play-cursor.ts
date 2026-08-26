export type PlayCursorController = {
  setVisible(visible: boolean): void;
  notePointer(pointerType: string, x: number, y: number): void;
  dispose(): void;
};

/**
 * Play cursor: CSS `none` by default. Show Cursor restores the OS cursor
 * for mouse, and a geometric ring for touch (no artwork).
 */
export function attachPlayCursor(canvas: HTMLCanvasElement): PlayCursorController {
  let visible = false;
  let pointerType = "mouse";
  let lastX = 0;
  let lastY = 0;
  const parent =
    typeof document !== "undefined" ? canvas.parentElement : null;
  const ring =
    parent && typeof document !== "undefined"
      ? document.createElement("div")
      : null;
  if (ring && parent) {
    ring.setAttribute("data-play-cursor", "touch");
    ring.style.position = "absolute";
    ring.style.width = "20px";
    ring.style.height = "20px";
    ring.style.margin = "0";
    ring.style.border = "2px solid #fff";
    ring.style.borderRadius = "50%";
    ring.style.boxSizing = "border-box";
    ring.style.pointerEvents = "none";
    ring.style.transform = "translate(-50%, -50%)";
    ring.style.boxShadow = "0 0 0 1px #000";
    ring.style.display = "none";
    parent.appendChild(ring);
  }

  const sync = () => {
    const touch = pointerType === "touch";
    canvas.style.cursor = visible && !touch ? "default" : "none";
    if (!ring) return;
    if (visible && touch) {
      ring.style.display = "block";
      ring.style.left = `${lastX}px`;
      ring.style.top = `${lastY}px`;
    } else {
      ring.style.display = "none";
    }
  };

  canvas.style.cursor = "none";
  sync();

  return {
    setVisible(next) {
      visible = next === true;
      sync();
    },
    notePointer(type, x, y) {
      if (type) pointerType = type;
      lastX = x;
      lastY = y;
      sync();
    },
    dispose() {
      ring?.remove();
      canvas.style.cursor = "";
    },
  };
}
