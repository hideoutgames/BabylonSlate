import type { RenderDiagnostics } from "@babylonslate/render";
import type { PlaySessionResult } from "./play-session";

/** Read-only view of the running Play session for in-app diagnostics. */
export interface PlayProbe {
  /** Loading phase while the scene loads; null once the first frame is presented. */
  loadingPhase(): { phase: string; progress: number } | null;
  tickIndex(): number;
  /** Runtime-reported frames per second; null before the first stats sample. */
  runtimeFps(): number | null;
  snapshot(): {
    drawCalls: number;
    meshes: number;
    textures: number;
    accountedBytes: number;
    rendering: RenderDiagnostics | null;
  };
  /** Error and warning lines the session logged, oldest first. */
  problemLogs(): Array<{ severity: string; message: string }>;
  executeConsoleCommand(line: string): Promise<{ success: boolean; output: string }>;
  stop(): void;
}

/** Load state of one Scene viewport, keyed by its document id. */
export interface ViewportProbe {
  ready(): boolean;
  failed(): boolean;
  phase(): string | null;
}

/** Latest registration wins; unregistering an older one leaves the newer intact. */
export class ProbeRegistry<T> {
  private readonly entries = new Map<string, T>();

  register(key: string, probe: T): () => void {
    this.entries.set(key, probe);
    return () => {
      if (this.entries.get(key) === probe) this.entries.delete(key);
    };
  }

  get(key: string): T | null {
    return this.entries.get(key) ?? null;
  }
}

export const playProbes = new ProbeRegistry<PlayProbe>();
export const viewportProbes = new ProbeRegistry<ViewportProbe>();
export const PLAY_PROBE_KEY = "play";

const closeListeners = new Set<(result: PlaySessionResult) => void>();
let automatedSessions = 0;

/** Notify in-app diagnostics that a Play session closed with `result`. */
export function publishPlaySessionClosed(result: PlaySessionResult): void {
  for (const listener of [...closeListeners]) listener(result);
}

export function onPlaySessionClosed(listener: (result: PlaySessionResult) => void): () => void {
  closeListeners.add(listener);
  return () => { closeListeners.delete(listener); };
}

/** While held, a closing session's diagnostics go to the automated run instead of the report dialog. */
export function holdAutomatedSessionReporting(): () => void {
  automatedSessions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    automatedSessions -= 1;
  };
}

export function automatedSessionReportingHeld(): boolean {
  return automatedSessions > 0;
}
