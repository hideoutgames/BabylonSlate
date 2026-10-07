export { attachInputCapture, type InputCaptureHandle } from "@babylonslate/input";

/** Tick stamp for canvas events. In-process uses World.clock; worker uses last snapshot tick. */
export function playInputStampTick(inProcessTickIndex: number | undefined, lastWorkerTickIndex: number): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
}
