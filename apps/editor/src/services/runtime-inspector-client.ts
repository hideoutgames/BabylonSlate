import type {
  RuntimeInspectorAction, RuntimeInspectorRequest, RuntimeInspectorResult, RuntimeObjectIdentity,
} from "@babylonslate/bridge";

type ClientAction<T> = T extends { sequence: number } ? Omit<T, "sequence"> & { sequence?: number } : T;
export type RuntimeInspectionAction = ClientAction<RuntimeInspectorAction>;
export type RuntimeInspectionWriteOptions = { continuous?: boolean; final?: boolean };
export type RuntimeInspectorRequestErrorCode = "stopped" | "superseded" | "budget" | "invalid" | "invalidated" | "timeout" | "transport";

export class RuntimeInspectorRequestError extends Error {
  readonly code: RuntimeInspectorRequestErrorCode;
  constructor(code: RuntimeInspectorRequestErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RuntimeInspectorRequestError";
  }
}

type Entry = {
  id: number; request: RuntimeInspectorRequest; bytes: number; lane: string; continuous: boolean;
  resolve: (result: RuntimeInspectorResult) => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>; sent: boolean;
};

/** Bounded typed transport. It never evaluates paths or retains a world snapshot. */
export class RuntimeInspectorClient {
  private readonly options: {
    sessionGeneration: number;
    send: (request: RuntimeInspectorRequest) => void | Promise<void>;
    maxRequests?: number; maxBytes?: number; timeoutMs?: number;
  };
  private nextId = 0;
  private nextWireId = 0;
  private closed = false;
  private bytes = 0;
  private readonly pending = new Map<number, Entry>();
  private readonly sent = new Map<number, Entry>();
  private readonly lanes = new Map<string, Entry[]>();

  constructor(options: {
    sessionGeneration: number;
    send: (request: RuntimeInspectorRequest) => void | Promise<void>;
    maxRequests?: number; maxBytes?: number; timeoutMs?: number;
  }) { this.options = options; }

  request(action: RuntimeInspectionAction, options: RuntimeInspectionWriteOptions = {}): Promise<RuntimeInspectorResult> {
    if (this.closed) return Promise.reject(error("stopped", "The game session has stopped."));
    let request: RuntimeInspectorRequest;
    let bytes: number;
    let lane: string;
    try {
      if (this.nextId >= Number.MAX_SAFE_INTEGER) throw error("budget", "The Inspector request identity budget was exhausted.");
      const requestId = this.nextId + 1;
      const copy = boundedCopy({ sessionGeneration: this.options.sessionGeneration, requestId, action }, 64 * 1024);
      request = copy.value as RuntimeInspectorRequest;
      bytes = copy.bytes + 24;
      validateAction(request.action);
      if (isWrite(request.action)) request.action.sequence = requestId;
      lane = actionLane(request.action);
    } catch (reason) { return Promise.reject(asError(reason)); }
    const queue = this.lanes.get(lane);
    const tail = queue?.at(-1);
    const replaced = isWrite(request.action) && (options.continuous || options.final) && tail?.continuous && !tail.sent ? tail : undefined;
    if (this.pending.size - Number(!!replaced) >= Math.min(this.options.maxRequests ?? 32, 32) ||
      this.bytes - (replaced?.bytes ?? 0) + bytes > (this.options.maxBytes ?? 256 * 1024)) {
      return Promise.reject(error("budget", "The Inspector pending request or byte budget was reached."));
    }
    // Check admission before superseding: a rejected oversized draft cannot erase
    // the previously accepted final value. Discrete and final edits are never replaced.
    if (replaced) this.finish(replaced, error("superseded", "A newer edit superseded this pending value."));
    this.nextId = request.requestId;
    return new Promise((resolve, reject) => {
      const entry: Entry = { id: request.requestId, request, bytes, lane, continuous: !!options.continuous && !options.final, resolve, reject, sent: false };
      this.pending.set(entry.id, entry);
      this.bytes += bytes;
      const entries = this.lanes.get(lane) ?? [];
      entries.push(entry);
      this.lanes.set(lane, entries);
      if (entries.length === 1) this.send(entry);
    });
  }

  receive(result: RuntimeInspectorResult): void {
    if (this.closed || result.sessionGeneration !== this.options.sessionGeneration) return;
    const entry = this.sent.get(result.requestId);
    if (!entry?.sent) return;
    try {
      const copied = boundedCopy(result, 64 * 1024).value as RuntimeInspectorResult;
      validateResult(entry.request, copied);
      this.finish(entry, undefined, copied);
    } catch (reason) { this.finish(entry, asError(reason)); }
  }

  /** Structural events invalidate exact live requests; future identities may reuse a GUID. */
  invalidateActor(actorGuid: string): void {
    this.invalidate(entry => "target" in entry.request.action && entry.request.action.target.actorGuid === actorGuid,
      "The runtime actor was destroyed.");
  }

  invalidateScene(sceneInstanceId?: string): void {
    this.invalidate(entry => !sceneInstanceId || !("target" in entry.request.action) ||
      entry.request.action.target.sceneInstanceId === sceneInstanceId, "The runtime scene instance changed.");
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidate(() => true, "The game session stopped before inspection completed.", "stopped");
  }

  get pendingCount(): number { return this.pending.size; }
  get pendingBytes(): number { return this.bytes; }

  private invalidate(matches: (entry: Entry) => boolean, message: string, code: RuntimeInspectorRequestErrorCode = "invalidated"): void {
    // Remove all selected entries before pumping lanes, so destruction cannot
    // send the queued write that follows an invalidated in-flight request.
    const lanes = new Set<string>();
    for (const entry of [...this.pending.values()]) {
      if (!matches(entry)) continue;
      lanes.add(entry.lane);
      this.finish(entry, error(code, message), undefined, false);
    }
    for (const lane of lanes) this.pump(lane);
  }

  private send(entry: Entry): void {
    if (this.closed || entry.sent) return;
    entry.sent = true;
    // A queued write may follow a request on a different lane. Allocate wire
    // correlation IDs at dispatch so the runtime's monotonic channel stays valid.
    entry.request.requestId = ++this.nextWireId;
    this.sent.set(entry.request.requestId, entry);
    entry.timer = setTimeout(() => {
      this.invalidate(candidate => candidate.lane === entry.lane, "The runtime did not acknowledge this Inspector request.", "timeout");
    }, this.options.timeoutMs ?? 10_000);
    try {
      const sent = this.options.send(entry.request);
      if (sent) void sent.catch(reason => this.finish(entry, error("transport", asError(reason).message)));
    } catch (reason) { this.finish(entry, error("transport", asError(reason).message)); }
  }

  private finish(entry: Entry, failure?: Error, result?: RuntimeInspectorResult, pump = true): void {
    if (!this.pending.delete(entry.id)) return;
    if (entry.sent) this.sent.delete(entry.request.requestId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    const queue = this.lanes.get(entry.lane);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) this.lanes.delete(entry.lane);
    }
    if (failure) entry.reject(failure); else entry.resolve(result!);
    if (pump) this.pump(entry.lane);
  }

  private pump(lane: string): void {
    const first = this.lanes.get(lane)?.[0];
    if (first) this.send(first);
  }
}

function error(code: RuntimeInspectorRequestErrorCode, message: string): RuntimeInspectorRequestError {
  return new RuntimeInspectorRequestError(code, message);
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function isWrite(action: RuntimeInspectionAction): action is Extract<RuntimeInspectorAction, { sequence: number }> {
  return action.kind === "setProperty" || action.kind === "setTransform" || action.kind === "setMaterialParameter";
}
function identityKey(target: RuntimeObjectIdentity): string {
  return JSON.stringify([target.sceneInstanceId, target.actorGuid, target.actorToken, target.componentGuid ?? null, target.componentToken ?? null]);
}
function actionLane(action: RuntimeInspectorAction): string {
  if (action.kind === "identities") return "identities";
  const target = identityKey(action.target);
  if (action.kind === "setProperty") return `${target}:property:${action.property}`;
  if (action.kind === "setTransform") return `${target}:transform`;
  if (action.kind === "setMaterialParameter") return `${target}:material:${action.parameter}`;
  return `${target}:read:${action.kind}:${action.kind === "value" ? action.property : ""}`;
}
function validateAction(action: RuntimeInspectorAction): void {
  if (!action || !["identities", "selection", "value", "setProperty", "setTransform", "setMaterialParameter"].includes(action.kind))
    throw error("invalid", "Unsupported runtime Inspector request.");
  if (action.kind === "identities") return;
  const target = action.target;
  if (!target || typeof target.actorGuid !== "string" || typeof target.sceneInstanceId !== "string" ||
    !Number.isSafeInteger(target.actorToken) || target.actorToken < 1 ||
    (target.componentGuid !== undefined && (typeof target.componentGuid !== "string" || !Number.isSafeInteger(target.componentToken) || target.componentToken! < 1)))
    throw error("invalid", "The runtime object identity is invalid.");
  if (((action.kind === "setProperty" || action.kind === "value") && typeof action.property !== "string") ||
    (action.kind === "setMaterialParameter" && (typeof action.parameter !== "string" || typeof action.materialGuid !== "string")))
    throw error("invalid", "The runtime field identity is invalid.");
}
function validateResult(request: RuntimeInspectorRequest, result: RuntimeInspectorResult): void {
  if (typeof result.success !== "boolean" || ![result.tickIndex, result.frameId, result.commandRevision, result.structuralRevision]
    .every(value => Number.isSafeInteger(value) && value >= 0)) throw error("invalid", "Invalid runtime Inspector acknowledgment.");
  if (!result.success) return;
  const action = request.action, payload = result.payload;
  if (!payload) throw error("invalid", "The runtime Inspector acknowledgment has no value.");
  if (isWrite(action)) {
    if (payload.kind !== "mutation" || payload.sequence !== action.sequence || identityKey(payload.target) !== identityKey(action.target))
      throw error("invalid", "The runtime acknowledged a different object or edit sequence.");
  } else if (payload.kind !== action.kind || (action.kind === "selection" && payload.kind === "selection" && identityKey(action.target) !== identityKey(payload.target)) ||
    (action.kind === "value" && payload.kind === "value" && payload.property !== action.property)) {
    throw error("invalid", "The runtime Inspector acknowledgment does not match the requested selection.");
  }
}

/** Count conservatively before copying each value, without unbounded JSON strings. */
function boundedCopy(input: unknown, limit: number): { value: unknown; bytes: number } {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > limit) throw error("budget", "An Inspector value exceeds the 64 KiB transport limit.");
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) throw error("budget", "An Inspector value exceeds the supported depth or item limit.");
    if (value === null || typeof value === "boolean") { add(5); return value; }
    if (typeof value === "string") { add(value.length * 3 + 2); return value; }
    if (typeof value === "number" && Number.isFinite(value)) { add(24); return value; }
    if (!value || typeof value !== "object" || active.has(value)) throw error("invalid", "Inspector requests require finite, acyclic typed values.");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw error("invalid", "Inspector requests cannot contain runtime object references.");
    active.add(value);
    add(2);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 8192) throw error("budget", "An Inspector array exceeds the supported item limit.");
      result = value.map(item => copy(item, depth + 1));
    } else {
      const object: Record<string, unknown> = Object.create(null);
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) throw error("invalid", "Inspector values cannot execute property getters.");
        const item: unknown = descriptor.value;
        if (item === undefined) continue;
        add(key.length * 3 + 4);
        object[key] = copy(item, depth + 1);
      }
      result = object;
    }
    active.delete(value);
    return result;
  };
  return { value: copy(input, 0), get bytes() { return bytes; } };
}
