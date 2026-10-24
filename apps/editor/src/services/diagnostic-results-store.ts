import type { PerformanceProfile } from "@haptic/debugger";
import type { RenderFrameReport } from "@haptic/render";

export type DiagnosticResult = { kind: "profile"; profile: PerformanceProfile } | { kind: "frame"; report: RenderFrameReport };
export type DiagnosticView = "summary" | "timeline" | "scripts" | "frame";
/** Opens a graph at a node; a message says why it could not. */
export type DiagnosticSourceOpener = (location: { assetGuid: string; graphId: string; nodeId: string }) => Promise<string | null>;
export type DiagnosticProfileOptions = { durationMs: number; byteBudget: number; gpuTiming?: boolean };
export type DiagnosticSessionPorts = {
  mode: "play" | "simulate" | "preview";
  startProfile(options: DiagnosticProfileOptions): Promise<void>;
  stopProfile(): Promise<PerformanceProfile | null>;
  captureFrame(): Promise<RenderFrameReport>;
  stopSession?(): void | Promise<unknown>;
};
/** A kept result: its short name (a recording number and time, or a file name) and the full label the history lists. */
export type DiagnosticHistoryEntry<T> = { id: number; name: string; label: string; value: T };
export type DiagnosticResultsSnapshot = {
  open: boolean; view: DiagnosticView; mode: DiagnosticSessionPorts["mode"] | null;
  active: "profile" | "frame" | null; busy: boolean; error: string | null;
  /** The shown recording and the shown frame capture, kept apart so neither replaces the other. */
  profile: PerformanceProfile | null;
  frame: RenderFrameReport | null;
  /** Recent recordings and captures, newest first, recorded or opened from a file. */
  profiles: readonly DiagnosticHistoryEntry<PerformanceProfile>[];
  frames: readonly DiagnosticHistoryEntry<RenderFrameReport>[];
  /** The recording the Summary compares the shown one with; it stays while new recordings arrive. */
  baselineId: number | null;
};

/** Recordings kept: at most this many, and at most this many retained bytes (the newest always stays). */
export const PROFILE_HISTORY_COUNT = 5;
export const PROFILE_HISTORY_BYTES = 64 * 1024 * 1024;
/** Frame captures kept. */
export const FRAME_HISTORY_COUNT = 5;

const clock = (at: Date) => [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");

/**
 * Recent results of each kind and event-driven UI state. No observer, timer or world polling. The
 * window floats over the game and never takes its input. The history lasts as long as the editor,
 * so a recording from an earlier Play session can be compared with a new one.
 */
export class DiagnosticResultsStore {
  private state: DiagnosticResultsSnapshot = {
    open: false, view: "summary", mode: null, active: null, busy: false, error: null, profile: null, frame: null,
    profiles: [], frames: [], baselineId: null,
  };
  private nextId = 1;
  private recordings = 0;
  private captures = 0;
  private readonly now: () => Date;
  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }
  private readonly listeners = new Set<() => void>();
  private session: { ports: DiagnosticSessionPorts; token: object } | null = null;
  private sourceOpener: DiagnosticSourceOpener | null = null;
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  open(view: DiagnosticView = "summary"): void {
    this.update({ open: true, view });
  }
  close(): void {
    this.update({ open: false });
  }
  selectView(view: DiagnosticView): void { this.update({ view }); }
  /** A saved result joins the history under its file name. */
  importResult(result: DiagnosticResult, name = "Opened Result"): void {
    if (this.state.active || this.state.busy) throw new Error("Stop the active diagnostic operation before opening another result.");
    if (result.kind === "frame") this.update({ ...this.keepFrame(result.report, name), error: null, view: "frame" });
    else this.update({ ...this.keepProfile(result.profile, name), error: null, view: "summary" });
  }
  /** Show a kept recording or capture. */
  show(id: number): void {
    const profile = this.state.profiles.find((entry) => entry.id === id);
    if (profile) { this.update({ profile: profile.value, view: this.state.view === "frame" ? "summary" : this.state.view }); return; }
    const frame = this.state.frames.find((entry) => entry.id === id);
    if (frame) this.update({ frame: frame.value, view: "frame" });
  }
  /** Compare the shown recording with a kept one in the Summary, or stop comparing with null. */
  compareWith(id: number | null): void {
    this.update({ baselineId: id !== null && this.state.profiles.some((entry) => entry.id === id) ? id : null });
  }
  /** The editor sets how a result opens its sources; it outlives sessions, so any kept recording's rows open. */
  setSourceOpener(opener: DiagnosticSourceOpener | null): void { this.sourceOpener = opener; }
  /** Opens a graph at a node, as the Scripts view does for an entry; resolves with why it could not, or null. */
  openSource(location: { assetGuid: string; graphId: string; nodeId: string }): Promise<string | null> {
    return this.sourceOpener ? this.sourceOpener(location) : Promise.resolve("The editor cannot open graphs right now.");
  }
  bindSession(ports: DiagnosticSessionPorts) {
    const session = { ports, token: {} };
    this.session = session;
    this.update({ mode: ports.mode, active: null, busy: false, error: null });
    return {
      publishProfile: (profile: PerformanceProfile) => {
        if (this.session !== session) return;
        this.update({ ...this.keepProfile(profile), active: null, busy: false, error: null });
      },
      publishFrame: (report: RenderFrameReport) => {
        if (this.session !== session) return;
        this.update({ ...this.keepFrame(report), active: null, busy: false, error: null, view: "frame" });
      },
      publishError: (reason: string) => this.fail(session, reason),
      release: () => {
        if (this.session !== session) return;
        this.session = null;
        this.update({ mode: null, active: null, busy: false });
      },
    };
  }
  async startProfile(options: DiagnosticProfileOptions): Promise<void> {
    const session = this.available();
    if (!session) return;
    this.update({ active: "profile", busy: true, error: null });
    try {
      await session.ports.startProfile(options);
      if (this.session === session) this.update({ busy: false });
    } catch (error) { this.fail(session, error); }
  }
  async stopProfile(): Promise<void> {
    const session = this.session;
    if (!session || this.state.active !== "profile" || this.state.busy) return;
    this.update({ busy: true });
    try {
      const profile = await session.ports.stopProfile();
      if (this.session === session) this.update({ active: null, busy: false, ...(profile ? this.keepProfile(profile) : {}) });
    } catch (error) { this.fail(session, error); }
  }
  async captureFrame(): Promise<void> {
    const session = this.available();
    if (!session) return;
    this.open("frame");
    this.update({ active: "frame", busy: true, error: null });
    try {
      const report = await session.ports.captureFrame();
      if (this.session === session) this.update({ ...this.keepFrame(report), active: null, busy: false });
    } catch (error) { this.fail(session, error); }
  }
  async stopSession(): Promise<void> {
    const session = this.session;
    try { await session?.ports.stopSession?.(); }
    catch (error) { if (session) this.fail(session, error); }
  }
  private available() {
    if (!this.session || this.session.ports.mode === "simulate") {
      this.update({ error: "Use Play or Preview Build for recording and frame capture." });
      return null;
    }
    if (this.state.active || this.state.busy) { this.update({ error: "Finish the current diagnostic operation first." }); return null; }
    return this.session;
  }
  /** Show a recording and keep it; the same one arriving twice (published and returned by Stop) is kept once. */
  private keepProfile(profile: PerformanceProfile, name?: string): Partial<DiagnosticResultsSnapshot> {
    if (this.state.profiles.some((entry) => entry.value === profile)) return { profile };
    const shortName = name ?? `Recording ${++this.recordings} · ${clock(this.now())}`;
    const label = `${shortName} · ${(profile.durationMs / 1000).toFixed(2)} s · ${profile.frames.count} Frames`;
    const profiles: DiagnosticHistoryEntry<PerformanceProfile>[] = [{ id: this.nextId++, name: shortName, label, value: profile }];
    let bytes = profile.retainedBytes;
    for (const entry of this.state.profiles) {
      if (profiles.length === PROFILE_HISTORY_COUNT || bytes + entry.value.retainedBytes > PROFILE_HISTORY_BYTES) break;
      profiles.push(entry);
      bytes += entry.value.retainedBytes;
    }
    const baselineId = profiles.some((entry) => entry.id === this.state.baselineId) ? this.state.baselineId : null;
    return { profile, profiles, baselineId };
  }
  private keepFrame(report: RenderFrameReport, name?: string): Partial<DiagnosticResultsSnapshot> {
    if (this.state.frames.some((entry) => entry.value === report)) return { frame: report };
    const shortName = name ?? `Capture ${++this.captures} · ${clock(this.now())}`;
    const label = `${shortName} · Frame ${report.frame.renderFrameId}`;
    return { frame: report, frames: [{ id: this.nextId++, name: shortName, label, value: report }, ...this.state.frames].slice(0, FRAME_HISTORY_COUNT) };
  }
  private fail(session: NonNullable<DiagnosticResultsStore["session"]>, error: unknown) {
    if (this.session === session) this.update({ active: null, busy: false, error: error instanceof Error ? error.message : String(error) });
  }
  private update(patch: Partial<DiagnosticResultsSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
