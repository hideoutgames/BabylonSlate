import type {
  CommandMessage, SessionBoundaryResult, SimulationCaptureIdentity, SimulationCaptureRequest, SimulationQuiesceRequest,
} from "@babylonslate/bridge";
import type { SerializedScene } from "@babylonslate/core";
import type { SimulationSceneCaptureResult } from "@babylonslate/runtime";

type CaptureCommand = Extract<CommandMessage, { type: "simulationQuiesced" | "simulationCaptureChunk" | "simulationCaptureResult" }>;
type Pending = {
  requestId: number; kind: "quiesce" | "capture"; maxBytes: number; renderRevision?: number;
  bytes: number; chunks: string[]; sequence: number; decoder: TextDecoder;
  resolve: (result: SessionBoundaryResult | SimulationSceneCaptureResult) => void;
  reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
};

/** One bounded final-state transfer, activated only by explicit Keep/Retry. */
export class SimulationCaptureClient {
  private readonly ports: {
    generation: number;
    quiesce(request: SimulationQuiesceRequest): void | Promise<void>;
    capture(request: SimulationCaptureRequest): void | Promise<void>;
    timeoutMs?: number;
  };
  private nextId = 0;
  private stopped = false;
  private pending: Pending | null = null;
  private boundary: SessionBoundaryResult | null = null;

  constructor(ports: SimulationCaptureClient["ports"]) { this.ports = ports; }

  quiesce(): Promise<SessionBoundaryResult> {
    return this.request("quiesce", 0) as Promise<SessionBoundaryResult>;
  }
  capture(renderRevision: number, maxBytes = 16 * 1024 * 1024): Promise<SimulationSceneCaptureResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024)
      return Promise.reject(new Error("Final scene capture budget must be between 1 byte and 64 MiB."));
    if (!this.boundary?.success || renderRevision !== this.boundary.commandRevision)
      return Promise.reject(new Error("Final scene capture requires the acknowledged runtime and render boundary."));
    return this.request("capture", maxBytes, renderRevision) as Promise<SimulationSceneCaptureResult>;
  }

  receive(command: CaptureCommand): void {
    const pending = this.pending;
    if (!pending || this.stopped || command.sessionGeneration !== this.ports.generation || command.requestId !== pending.requestId) return;
    try {
      if (command.type === "simulationQuiesced") {
        if (pending.kind !== "quiesce" || !Number.isSafeInteger(command.commandRevision) || command.commandRevision < 0 ||
          !Number.isSafeInteger(command.tickIndex) || command.tickIndex < 0 || typeof command.success !== "boolean" ||
          (command.success && (!command.paused || typeof command.sceneAssetGuid !== "string" || !Number.isSafeInteger(command.sceneLoadId))))
          throw new Error("Invalid Simulation quiescence acknowledgment.");
        this.boundary = command;
        this.finish(command);
      } else if (command.type === "simulationCaptureChunk") {
        if (pending.kind !== "capture" || command.sequence !== pending.sequence || !(command.bytes instanceof Uint8Array) ||
          command.bytes.byteLength < 1 || command.bytes.byteLength > 64 * 1024 || pending.bytes + command.bytes.byteLength > pending.maxBytes ||
          pending.sequence >= Math.ceil(pending.maxBytes / 4096) + 1)
          throw new Error("Final scene capture has missing, invalid, or oversized chunks.");
        pending.bytes += command.bytes.byteLength;
        pending.sequence++;
        pending.chunks.push(pending.decoder.decode(command.bytes, { stream: true }));
      } else {
        if (pending.kind !== "capture") throw new Error("Unexpected final scene capture acknowledgment.");
        const result = command.result;
        if (!result.ok) {
          if (result.identity.generation !== this.ports.generation) throw new Error("Stale final capture failure.");
          this.finish(result); return;
        }
        this.validateIdentity(result.identity, pending);
        if (result.byteSize !== pending.bytes || result.chunkCount !== pending.sequence || !pending.sequence)
          throw new Error("Final scene capture is incomplete; its byte or chunk count does not match.");
        pending.chunks.push(pending.decoder.decode());
        const scene: unknown = JSON.parse(pending.chunks.join(""));
        if (!scene || typeof scene !== "object" || !Array.isArray((scene as SerializedScene).actors))
          throw new Error("The final scene capture is not a Scene document.");
        this.finish({ ok: true, identity: result.identity, byteSize: result.byteSize, scene: scene as SerializedScene });
      }
    } catch (reason) { this.fail(reason); }
  }

  /** In-process runtime already owns a complete canonical candidate: no JSON copy. */
  receiveComplete(request: SimulationCaptureRequest, result: SimulationSceneCaptureResult): void {
    const pending = this.pending;
    if (this.stopped || !pending || pending.kind !== "capture" || request.sessionGeneration !== this.ports.generation || request.requestId !== pending.requestId) return;
    try {
      if (!result.ok) {
        if (result.identity.generation !== this.ports.generation) throw new Error("Stale final capture failure.");
        this.finish(result); return;
      }
      this.validateIdentity(result.identity, pending);
      if (!Number.isSafeInteger(result.byteSize) || result.byteSize < 1 || result.byteSize > pending.maxBytes)
        throw new Error("Final scene capture exceeds its admitted byte budget.");
      this.finish(result);
    } catch (reason) { this.fail(reason); }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.fail(new Error("Simulation stopped before its final capture completed."));
    this.boundary = null;
  }

  private request(kind: Pending["kind"], maxBytes: number, renderRevision?: number): Promise<SessionBoundaryResult | SimulationSceneCaptureResult> {
    if (this.stopped) return Promise.reject(new Error("The Simulation capture owner has stopped."));
    if (this.pending) return Promise.reject(new Error("A final Simulation capture is already pending."));
    const requestId = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("The runtime did not complete its final Simulation capture.")), this.ports.timeoutMs ?? 30_000);
      const pending: Pending = { requestId, kind, maxBytes, renderRevision, bytes: 0, chunks: [], sequence: 0,
        decoder: new TextDecoder("utf-8", { fatal: true }), resolve, reject, timer };
      this.pending = pending;
      try {
        const identity = { sessionGeneration: this.ports.generation, requestId };
        const sent = kind === "quiesce" ? this.ports.quiesce(identity) : this.ports.capture({ ...identity, renderRevision: renderRevision!, maxBytes });
        if (sent) void sent.catch(reason => { if (this.pending === pending) this.fail(reason); });
      } catch (reason) { this.fail(reason); }
    });
  }

  private validateIdentity(identity: SimulationCaptureIdentity, pending: Pending): void {
    const boundary = this.boundary;
    if (!boundary || identity.generation !== this.ports.generation || identity.commandRevision !== pending.renderRevision ||
      identity.sceneAssetGuid !== boundary.sceneAssetGuid || identity.sceneLoadId !== boundary.sceneLoadId || identity.tickIndex !== boundary.tickIndex ||
      typeof identity.sceneInstanceId !== "string" || !identity.sceneInstanceId)
      throw new Error("The final capture no longer owns the acknowledged scene boundary.");
  }
  private finish(result: SessionBoundaryResult | SimulationSceneCaptureResult): void {
    const pending = this.take();
    pending?.resolve(result);
  }
  private fail(reason: unknown): void {
    const pending = this.take();
    pending?.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
  private take(): Pending | null {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.chunks.length = 0; }
    return pending;
  }
}
