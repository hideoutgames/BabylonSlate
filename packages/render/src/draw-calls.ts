/** Babylon 9 tracks per-frame draws on `engine._drawCalls` (a PerfCounter); it has no public `engine.drawCalls`. */

export type DrawCallEngine = {
  _drawCalls?: {
    current: number;
    fetchNewFrame?: () => void;
  };
};

/** Reset the PerfCounter at the start of a rendered frame. */
export function beginEngineDrawCallFrame(engine: DrawCallEngine): void {
  engine._drawCalls?.fetchNewFrame?.();
}

/** Last-frame draw calls from `_drawCalls.current`, or 0 without a finite count. */
export function readEngineDrawCalls(engine: DrawCallEngine): number {
  const current = engine._drawCalls?.current;
  return typeof current === "number" && Number.isFinite(current) ? current : 0;
}
