/** The fields of Electron's `ProcessMetric` this reads; memory sizes are in kilobytes. */
export interface DesktopProcessMetric {
  pid: number;
  type: string;
  memory: { workingSetSize: number };
}

/** Resident memory of the Electron processes behind one editor window, in bytes. */
export interface DesktopMemoryStats {
  /** The calling window's renderer: the page's JS, DOM and WebGL client side. */
  rendererProcessBytes: number | null;
  /** The shared GPU process, which holds WebGL textures and buffers. */
  gpuProcessBytes: number | null;
  mainProcessBytes: number | null;
  /** Every process of the app, other windows and helpers included. */
  allProcessesBytes: number;
}

const bytes = (kilobytes: number) => kilobytes * 1024;

/** `rendererPid` is the caller's own renderer (`event.sender.getOSProcessId()`). */
export function desktopMemoryStats(metrics: readonly DesktopProcessMetric[], rendererPid: number): DesktopMemoryStats {
  const of = (match: (metric: DesktopProcessMetric) => boolean) => {
    const found = metrics.filter(match);
    return found.length ? bytes(found.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)) : null;
  };
  return {
    rendererProcessBytes: of((metric) => metric.pid === rendererPid),
    gpuProcessBytes: of((metric) => metric.type === "GPU"),
    mainProcessBytes: of((metric) => metric.type === "Browser"),
    allProcessesBytes: bytes(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)),
  };
}
