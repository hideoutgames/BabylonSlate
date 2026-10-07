import { newGuid } from "@babylonslate/core";

export const PREVIEW_DIAGNOSTIC_MESSAGE = "babylonslate-preview-diagnostic-control";
export type PreviewDiagnosticOperation = "profile-start" | "profile-stop" | "frame" | "input";
export type PreviewDiagnosticSettings = { durationMs?: number; byteBudget?: number; inputSuppressed?: boolean; gpuTiming?: boolean };
export type PreviewDiagnosticResult = { success: boolean; reason?: string; result?: unknown };
export type PreviewProfileTransfer = { metadata: Record<string, unknown>; frames: Float64Array[]; ticks: Float64Array[] };
type Incoming = { source: unknown; origin: string; data: unknown };
export type PreviewDiagnosticEndpoint = {
  source(): unknown; origin(): string;
  send(message: unknown, transfer?: Transferable[]): void;
};
type Message = { type: typeof PREVIEW_DIAGNOSTIC_MESSAGE; client: string; session?: string;
  action: "open" | "ready" | "request" | "result" | "profile-start" | "profile-chunk" | "profile-end" | "profile-error" | "close";
  requestId?: number; operation?: PreviewDiagnosticOperation; durationMs?: number; byteBudget?: number; inputSuppressed?: boolean; gpuTiming?: boolean;
  success?: boolean; reason?: string; result?: unknown; profileId?: number; metadata?: Record<string, unknown>;
  stream?: "frames" | "ticks"; sequence?: number; rows?: Float64Array };
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128;
const validSequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024;
function trusted(event: Incoming, endpoint: PreviewDiagnosticEndpoint): Message | null {
  if (!endpoint.source() || event.source !== endpoint.source() || event.origin !== endpoint.origin()) return null;
  const value = event.data as Partial<Message> | null;
  return value?.type === PREVIEW_DIAGNOSTIC_MESSAGE && validId(value.client) ? value as Message : null;
}

/** Transport only: viewing results never starts a recording. Source, origin,
 * client nonce and player session must all match before results are consumed. */
export function createPreviewDiagnosticClient(endpoint: PreviewDiagnosticEndpoint, options: {
  onProfile: (transfer: PreviewProfileTransfer) => void;
  onError?: (reason: string) => void;
}) {
  const client = newGuid();
  let session: string | undefined;
  let closed = false;
  let sequence = 0;
  let opening: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const pending = new Map<number, { resolve: (result: PreviewDiagnosticResult) => void; timer: ReturnType<typeof setTimeout> }>();
  let capture: { id: number; metadata: Record<string, unknown>; frames: Float64Array[]; ticks: Float64Array[];
    bytes: number; limit: number; sequence: number; timer: ReturnType<typeof setTimeout> } | undefined;
  const send = (message: Omit<Message, "type" | "client" | "session">) => endpoint.send({ type: PREVIEW_DIAGNOSTIC_MESSAGE, client, session, ...message });
  const cancelRequests = (reason: string) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ success: false, reason }); }
    pending.clear();
  };
  const clearCapture = (reason?: string) => {
    if (capture) clearTimeout(capture.timer);
    capture = undefined;
    if (reason) options.onError?.(reason);
  };
  const connect = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("Preview diagnostics closed."));
    if (session) return Promise.resolve();
    if (opening) return opening.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => { opening = undefined; reject(new Error("Preview diagnostics did not respond.")); }, 10_000);
    opening = { promise, resolve, reject, timer };
    try { send({ action: "open" }); }
    catch (error) { clearTimeout(timer); opening = undefined; reject(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  };
  return {
    connect,
    async request(operation: PreviewDiagnosticOperation, settings: PreviewDiagnosticSettings = {}): Promise<PreviewDiagnosticResult> {
      try { await connect(); } catch (error) { return { success: false, reason: String(error) }; }
      if (closed || pending.size >= 4) return { success: false, reason: "Preview diagnostic request limit reached." };
      const requestId = ++sequence;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(requestId); resolve({ success: false, reason: "Preview diagnostic request timed out." }); }, 15_000);
        pending.set(requestId, { resolve, timer });
        try { send({ action: "request", requestId, operation, ...settings }); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); resolve({ success: false, reason: String(error) }); }
      });
    },
    receive(event: Incoming): void {
      if (closed) return;
      const message = trusted(event, endpoint);
      if (!message || message.client !== client) return;
      if (message.action === "ready" && validId(message.session)) {
        if (!opening && session !== message.session) return;
        if (session && session !== message.session) { cancelRequests("Preview player was replaced."); clearCapture(); }
        session = message.session;
        if (opening) { clearTimeout(opening.timer); opening.resolve(); opening = undefined; }
        return;
      }
      if (!session || message.session !== session) return;
      if (message.action === "result" && validSequence(message.requestId)) {
        const item = pending.get(message.requestId);
        if (!item || typeof message.success !== "boolean") return;
        pending.delete(message.requestId); clearTimeout(item.timer);
        item.resolve({ success: message.success, reason: message.reason, result: message.result });
      } else if (message.action === "profile-start" && validSequence(message.profileId)) {
        clearCapture();
        const metadata = message.metadata;
        const limit = metadata?.byteBudget;
        if (!metadata || !validSequence(limit) || limit < 1024 || limit > MAX_TRANSFER_BYTES) { options.onError?.("Invalid Preview profile budget."); return; }
        capture = { id: message.profileId, metadata, frames: [], ticks: [], bytes: 0, limit, sequence: 0,
          timer: setTimeout(() => clearCapture("Preview profile transfer timed out."), 10_000) };
      } else if (message.action === "profile-chunk" && capture && message.profileId === capture.id) {
        if (message.sequence !== capture.sequence || (message.stream !== "frames" && message.stream !== "ticks") ||
          !(message.rows instanceof Float64Array) || !message.rows.byteLength || message.rows.byteLength > MAX_CHUNK_BYTES ||
          capture.bytes + message.rows.byteLength > capture.limit) {
          clearCapture("Preview profile transfer was incomplete or exceeded its data budget."); return;
        }
        capture.sequence++;
        capture.bytes += message.rows.byteLength;
        capture[message.stream].push(message.rows);
      } else if (message.action === "profile-end" && capture && message.profileId === capture.id) {
        const complete = capture;
        clearCapture();
        if (message.sequence !== complete.sequence) { options.onError?.("Preview profile transfer lost chunks."); return; }
        options.onProfile({ metadata: complete.metadata, frames: complete.frames, ticks: complete.ticks });
      } else if (message.action === "profile-error") clearCapture(message.reason ?? "Preview profile transfer failed.");
    },
    dispose(): void {
      if (closed) return;
      try { if (session) send({ action: "close" }); }
      finally {
        closed = true;
        if (opening) { clearTimeout(opening.timer); opening.reject(new Error("Preview diagnostics closed.")); opening = undefined; }
        cancelRequests("Preview diagnostics closed."); clearCapture(); session = undefined;
      }
    },
  };
}

/** Loaded only by the actual packaged player's explicit Preview handshake. */
export function createPreviewDiagnosticServer(endpoint: PreviewDiagnosticEndpoint, options: {
  execute: (operation: PreviewDiagnosticOperation, settings: PreviewDiagnosticSettings) => Promise<PreviewDiagnosticResult>;
  close: () => void | Promise<void>;
}) {
  const session = newGuid();
  let client: string | undefined;
  let closed = false;
  let profileSequence = 0;
  let lastRequestId = -1;
  let inFlight = 0;
  const send = (message: Omit<Message, "type" | "client" | "session">, transfer?: Transferable[]) => {
    if (!closed && client) endpoint.send({ type: PREVIEW_DIAGNOSTIC_MESSAGE, client, session, ...message }, transfer);
  };
  return {
    async publishProfile(transfer: PreviewProfileTransfer): Promise<void> {
      if (closed || !client) return;
      const owner = client;
      const profileId = ++profileSequence;
      let sequence = 0;
      try {
        send({ action: "profile-start", profileId, metadata: transfer.metadata });
        for (const stream of ["frames", "ticks"] as const) for (const source of transfer[stream]) {
          if (closed || client !== owner) return;
          if (source.byteLength > MAX_CHUNK_BYTES) throw new Error("Preview profile chunk exceeds the transport budget.");
          const rows = source.slice();
          send({ action: "profile-chunk", profileId, stream, sequence: sequence++, rows }, [rows.buffer]);
          if (sequence % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!closed && client === owner) send({ action: "profile-end", profileId, sequence });
      } catch (error) { send({ action: "profile-error", profileId, reason: String(error) }); }
    },
    receive(event: Incoming): void {
      if (closed) return;
      const message = trusted(event, endpoint);
      if (!message) return;
      if (message.action === "open") {
        if (client && client !== message.client) { void options.close(); lastRequestId = -1; }
        client = message.client;
        send({ action: "ready" }); return;
      }
      if (!client || message.client !== client || message.session !== session) return;
      if (message.action === "close") { client = undefined; lastRequestId = -1; void options.close(); return; }
      if (message.action !== "request" || !validSequence(message.requestId) || message.requestId <= lastRequestId ||
        !["profile-start", "profile-stop", "frame", "input"].includes(String(message.operation))) return;
      lastRequestId = message.requestId;
      const requestId = message.requestId;
      if (inFlight >= 4) { send({ action: "result", requestId, success: false, reason: "Too many Preview diagnostic requests." }); return; }
      if ((message.operation === "input" && typeof message.inputSuppressed !== "boolean") ||
        (message.gpuTiming !== undefined && typeof message.gpuTiming !== "boolean") ||
        (message.durationMs !== undefined && (!validSequence(message.durationMs) || message.durationMs < 1000 || message.durationMs > 60_000)) ||
        (message.byteBudget !== undefined && (!validSequence(message.byteBudget) || message.byteBudget < 4 * 1024 * 1024 || message.byteBudget > MAX_TRANSFER_BYTES))) {
        send({ action: "result", requestId, success: false, reason: "Invalid Preview recording settings." }); return;
      }
      inFlight++;
      const owner = client;
      void options.execute(message.operation!, { durationMs: message.durationMs, byteBudget: message.byteBudget, inputSuppressed: message.inputSuppressed, gpuTiming: message.gpuTiming })
        .then((result) => { if (client === owner) send({ action: "result", requestId, ...result }); },
          (error: unknown) => { if (client === owner) send({ action: "result", requestId, success: false, reason: String(error) }); })
        .finally(() => { inFlight--; });
    },
    dispose(): void { if (closed) return; closed = true; void options.close(); },
  };
}
