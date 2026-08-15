/**
 * Babylon 9 tracks per-frame draws on `engine._drawCalls` (a PerfCounter).
 * There is no public `engine.drawCalls` number — reading that always yields
 * `undefined`, which Play previously coalesced to 0.
 */

export type DrawCallEngine = {
  drawCalls?: number;
  _drawCalls?: {
    current: number;
    fetchNewFrame?: () => void;
  };
};

/** Reset the PerfCounter at the start of a rendered frame. */
export function beginEngineDrawCallFrame(engine: DrawCallEngine): void {
  engine._drawCalls?.fetchNewFrame?.();
}

/**
 * Last-frame draw calls. Prefers `_drawCalls.current`; `drawCalls` is a
 * fallback for engines that expose a number.
 */
export function readEngineDrawCalls(engine: DrawCallEngine): number {
  const fromPerf = engine._drawCalls?.current;
  if (typeof fromPerf === "number" && Number.isFinite(fromPerf)) {
    return fromPerf;
  }
  return engine.drawCalls ?? 0;
}
