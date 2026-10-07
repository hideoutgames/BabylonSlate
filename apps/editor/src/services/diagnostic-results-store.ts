import type { PerformanceProfile } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";

export type DiagnosticResult = { kind: "profile"; profile: PerformanceProfile } | { kind: "frame"; report: RenderFrameReport };
export type DiagnosticView = "summary" | "timeline" | "frame";
export type DiagnosticProfileOptions = { durationMs: number; byteBudget: number; gpuTiming?: boolean };
export type DiagnosticSessionPorts = {
  mode: "play" | "simulate" | "preview";
  startProfile(options: DiagnosticProfileOptions): Promise<void>;
  stopProfile(): Promise<PerformanceProfile | null>;
  captureFrame(): Promise<RenderFrameReport>;
  stopSession?(): void | Promise<unknown>;
  releaseInput?(): void | Promise<unknown>;
  setSurfaceOpen?(open: boolean): void | Promise<unknown>;
};
export type DiagnosticResultsSnapshot = {
  open: boolean; view: DiagnosticView; mode: DiagnosticSessionPorts["mode"] | null;
  active: "profile" | "frame" | null; busy: boolean; error: string | null; result: DiagnosticResult | null;
};

/** One recent result and event-driven UI state. No observer, timer or world polling. */
export class DiagnosticResultsStore {
  private state: DiagnosticResultsSnapshot = { open: false, view: "summary", mode: null, active: null, busy: false, error: null, result: null };
  private readonly listeners = new Set<() => void>();
  private session: { ports: DiagnosticSessionPorts; token: object } | null = null;
  private surfaceRevision = 0;
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  open(view: DiagnosticView = "summary"): void {
    this.update({ open: true, view });
    const session = this.session;
    if (session) this.updateInputSurface(session, true);
  }
  close(): void {
    this.update({ open: false });
    const session = this.session;
    if (session) this.updateInputSurface(session, false);
  }
  selectView(view: DiagnosticView): void { this.update({ view }); }
  importResult(result: DiagnosticResult): void {
    if (this.state.active || this.state.busy) throw new Error("Stop the active diagnostic operation before opening another result.");
    this.update({ result, error: null, view: result.kind === "frame" ? "frame" : "summary" });
  }
  bindSession(ports: DiagnosticSessionPorts) {
    const session = { ports, token: {} };
    this.session = session;
    this.update({ mode: ports.mode, active: null, busy: false, error: null });
    if (this.state.open) this.updateInputSurface(session, true);
    return {
      publishProfile: (profile: PerformanceProfile) => {
        if (this.session !== session) return;
        this.update({ result: { kind: "profile", profile }, active: null, busy: false, error: null });
      },
      publishFrame: (report: RenderFrameReport) => {
        if (this.session !== session) return;
        this.update({ result: { kind: "frame", report }, active: null, busy: false, error: null, view: "frame" });
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
      if (this.session === session) this.update({ active: null, busy: false, ...(profile ? { result: { kind: "profile", profile } as DiagnosticResult } : {}) });
    } catch (error) { this.fail(session, error); }
  }
  async captureFrame(): Promise<void> {
    const session = this.available();
    if (!session) return;
    this.open("frame");
    this.update({ active: "frame", busy: true, error: null });
    try {
      const report = await session.ports.captureFrame();
      if (this.session === session) this.update({ result: { kind: "frame", report }, active: null, busy: false });
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
  private updateInputSurface(session: NonNullable<DiagnosticResultsStore["session"]>, open: boolean) {
    const revision = ++this.surfaceRevision;
    void (async () => {
      // Returning from a game gesture must complete before handing input to the
      // dialog. A close or replacement during that boundary supersedes this open.
      if (open) await session.ports.releaseInput?.();
      if (this.session !== session || revision !== this.surfaceRevision) return;
      await session.ports.setSurfaceOpen?.(open);
    })().catch(error => {
      if (this.session === session && revision === this.surfaceRevision)
        this.update({ error: error instanceof Error ? error.message : String(error) });
    });
  }
  private fail(session: NonNullable<DiagnosticResultsStore["session"]>, error: unknown) {
    if (this.session === session) this.update({ active: null, busy: false, error: error instanceof Error ? error.message : String(error) });
  }
  private update(patch: Partial<DiagnosticResultsSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
