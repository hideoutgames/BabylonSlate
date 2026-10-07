import type { CommandMessage } from "@babylonslate/bridge";

export type CommandFontMode = "bitmap" | "msdf" | "facetype";
/** An empty GUID selects the project's default font. */
export type CommandFontModes = ReadonlyMap<string, ReadonlySet<CommandFontMode>>;

/** The host owns storage/CPU preparation; the renderer keeps native resources. */
export type CommandSourceLoader = (guids: readonly string[], options: {
  slotId: number;
  consumer: string;
  signal: AbortSignal;
  fontModes?: CommandFontModes;
}) => Promise<() => void>;

type Assignment = Extract<CommandMessage, { type: "assignMesh" | "assignMaterial" | "assignParticle" }>;
interface Request {
  key: string;
  slotId: number;
  command: Assignment;
  guids: string[];
  fontModes: CommandFontModes;
  representationKey: string;
  controller: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  apply: (command: CommandMessage) => void;
  order: number;
  preparedRelease?: () => void;
}

/** Hold the previous visual and its sources until a cold replacement is usable. */
export class CommandSourcePreparation {
  private loader: CommandSourceLoader | null = null;
  private readonly pending = new Map<string, Request>();
  private readonly retained = new Map<string, { slotId: number; release: () => void }>();
  private readonly failures = new Map<string, { slotId: number; error: Error }>();
  private readonly followers = new Map<number, Array<{ command: CommandMessage; apply: (command: CommandMessage) => void }>>();
  private readonly queue: Request[] = [];
  private active = 0;
  private nextOrder = 0;
  private disposed = false;
  private readonly onError: (error: Error) => void;
  private readonly concurrency: number;

  constructor(options: { onError?: (error: Error) => void; concurrency?: number } = {}) {
    this.onError = options.onError ?? (() => undefined);
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) throw new Error("Source preparation concurrency must be positive");
  }

  setLoader(loader: CommandSourceLoader | null): void {
    this.clear();
    this.loader = loader;
  }

  /** True means the command is owned by this asynchronous preparation queue. */
  receive(command: CommandMessage, apply: (command: CommandMessage) => void): boolean {
    if (!this.loader || this.disposed) return false;
    if (command.type === "despawn") {
      // Native consumers retire before their source ownership is released.
      apply(command);
      this.releaseSlots([command.slotId]);
      return true;
    }
    if (command.type !== "assignMesh" && command.type !== "assignMaterial" && command.type !== "assignParticle") {
      if ("slotId" in command && [...this.pending.values()].some((request) => request.slotId === command.slotId)) {
        const waiting = this.followers.get(command.slotId) ?? [];
        waiting.push({ command, apply });
        this.followers.set(command.slotId, waiting);
        return true;
      }
      return false;
    }
    const key = commandKey(command);
    const guids = commandSourceGuids(command);
    const fontModes = commandFontModes(command);
    const representationKey = JSON.stringify([guids, [...fontModes].map(([guid, modes]) => [guid, [...modes].sort()])]);
    const existing = this.pending.get(key);
    if (existing && existing.representationKey === representationKey) {
      existing.command = command;
      return true;
    }
    if (existing) this.cancel(existing);
    this.failures.delete(key);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const request: Request = { key, slotId: command.slotId, command, guids, fontModes, representationKey, controller: new AbortController(), promise, resolve, reject, apply, order: this.nextOrder++ };
    this.pending.set(key, request);
    if (guids.length || fontModes.size) { this.queue.push(request); this.pump(); }
    else { request.preparedRelease = () => undefined; this.publishSlot(command.slotId); }
    return true;
  }

  async whenReady(slotIds?: readonly number[], signal?: AbortSignal): Promise<void> {
    const wanted = slotIds && new Set(slotIds);
    for (;;) {
      signal?.throwIfAborted();
      const failure = [...this.failures.values()].find((entry) => !wanted || wanted.has(entry.slotId));
      if (failure) throw failure.error;
      const pending = [...this.pending.values()].filter((request) => !wanted || wanted.has(request.slotId));
      if (!pending.length) return;
      try { await abortable(Promise.all(pending.map((request) => request.promise)), signal); }
      catch {
        signal?.throwIfAborted();
        // A newer assignment or a despawn may supersede this snapshot. The
        // next pass observes its replacement or the persistent failure record.
      }
    }
  }

  pendingSlotIds(): number[] {
    return [...new Set([...this.pending.values(), ...this.failures.values()].map((entry) => entry.slotId))];
  }

  releaseSlots(slotIds: Iterable<number>): void {
    const slots = new Set(slotIds);
    for (const request of [...this.pending.values()]) if (slots.has(request.slotId)) this.cancel(request);
    for (const [key, owner] of this.retained) if (slots.has(owner.slotId)) {
      this.retained.delete(key);
      this.release(owner.release, owner.slotId);
    }
    for (const [key, failed] of this.failures) if (slots.has(failed.slotId)) this.failures.delete(key);
    for (const slotId of slots) this.followers.delete(slotId);
    this.pump();
  }

  clear(): void {
    this.releaseSlots(new Set([
      ...[...this.pending.values()].map((request) => request.slotId),
      ...[...this.retained.values()].map((owner) => owner.slotId),
      ...[...this.failures.values()].map((failure) => failure.slotId),
    ]));
  }

  dispose(): void { this.disposed = true; this.clear(); this.loader = null; }

  private cancel(request: Request): void {
    request.controller.abort();
    if (this.pending.get(request.key) === request) this.pending.delete(request.key);
    const index = this.queue.indexOf(request);
    if (index !== -1) this.queue.splice(index, 1);
    if (request.preparedRelease) this.release(request.preparedRelease, request.slotId);
    request.preparedRelease = undefined;
    request.reject(new Error(`Source preparation for slot ${request.slotId} was cancelled`));
  }

  private pump(): void {
    while (!this.disposed && this.loader && this.active < this.concurrency && this.queue.length) {
      const request = this.queue.shift()!;
      if (request.controller.signal.aborted) continue;
      this.active++;
      void this.prepare(request, this.loader);
    }
  }

  private async prepare(request: Request, loader: CommandSourceLoader): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await loader(request.guids, {
        slotId: request.slotId, consumer: `Actor Slot ${request.slotId}: ${request.command.type}`,
        signal: request.controller.signal,
        fontModes: request.fontModes,
      });
      if (request.controller.signal.aborted || this.pending.get(request.key) !== request || this.disposed) return;
      request.preparedRelease = release;
      release = undefined;
      this.publishSlot(request.slotId);
    } catch (cause) {
      if (this.pending.get(request.key) === request) {
        this.pending.delete(request.key);
        const error = new Error(`Assets ${request.guids.join(", ")} for actor slot ${request.slotId} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.failures.set(request.key, { slotId: request.slotId, error });
        for (const pending of [...this.pending.values()]) if (pending.slotId === request.slotId) this.cancel(pending);
        this.followers.delete(request.slotId);
        request.reject(error);
        this.onError(error);
      }
    } finally {
      try { if (release) this.release(release, request.slotId); }
      finally { this.active--; this.pump(); }
    }
  }

  private publishSlot(slotId: number): void {
    if ([...this.failures.values()].some((failure) => failure.slotId === slotId)) return;
    const requests = [...this.pending.values()].filter((request) => request.slotId === slotId).sort((a, b) => a.order - b.order);
    for (const request of requests) {
      const release = request.preparedRelease;
      if (!release) return;
      try { request.apply(request.command); }
      catch (cause) {
        const error = new Error(`Prepared assignment for actor slot ${slotId} failed: ${String(cause)}`, { cause });
        this.failures.set(request.key, { slotId, error });
        for (const pending of [...this.pending.values()]) if (pending.slotId === slotId) this.cancel(pending);
        this.followers.delete(slotId);
        this.onError(error);
        return;
      }
      const previous = this.retained.get(request.key);
      this.retained.set(request.key, { slotId, release });
      request.preparedRelease = undefined;
      this.pending.delete(request.key);
      try { previous?.release(); }
      catch (error) { this.onError(new Error(`Source cleanup for actor slot ${slotId} failed: ${String(error)}`, { cause: error })); }
      request.resolve();
    }
    this.flushFollowers(slotId);
  }

  private flushFollowers(slotId: number): void {
    if ([...this.pending.values()].some((request) => request.slotId === slotId)) return;
    const followers = this.followers.get(slotId) ?? [];
    this.followers.delete(slotId);
    for (const { command, apply } of followers) apply(command);
  }

  private release(release: () => void, slotId: number): void {
    try { release(); }
    catch (cause) { this.onError(new Error(`Source cleanup for actor slot ${slotId} failed: ${String(cause)}`, { cause })); }
  }
}

function commandFontModes(command: Assignment): CommandFontModes {
  const fonts = new Map<string, Set<CommandFontMode>>();
  const add = (guid: string | null, mode: CommandFontMode) => {
    const key = guid ?? "";
    const modes = fonts.get(key) ?? new Set<CommandFontMode>();
    modes.add(mode);
    fonts.set(key, modes);
  };
  if (command.type === "assignMesh") for (const part of [command, ...(command.parts ?? [])]) {
    if (part.text2d) add(part.text2d.fontAssetGuid, part.text2d.renderer);
    // A null 3D font uses the renderer's bundled font, not a project asset.
    if (part.text3d?.fontAssetGuid) add(part.text3d.fontAssetGuid, "facetype");
  }
  return new Map([...fonts].sort(([a], [b]) => a.localeCompare(b)));
}

function commandKey(command: Assignment): string {
  return `${command.slotId}:${command.type}:${"componentId" in command ? command.componentId ?? "" : ""}`;
}

/** Typed command fields only; arbitrary strings in gameplay values are not asset references. */
export function commandSourceGuids(command: Assignment): string[] {
  const guids = new Set<string>();
  const add = (guid: unknown) => { if (typeof guid === "string" && guid.trim()) guids.add(guid); };
  if (command.type === "assignMaterial") add(command.materialAssetGuid);
  else if (command.type === "assignParticle") add(command.particleSystemGuid);
  else {
    for (const part of [command, ...(command.parts ?? [])]) {
      add(part.meshAssetGuid);
      add(part.text2d?.fontAssetGuid);
      add(part.text2d?.materialGuid);
      add(part.text3d?.fontAssetGuid);
      if ("water" in part) add(part.water?.assetGuid);
      if ("landscape" in part) add(part.landscape?.materialGuid);
      if ("foliage" in part) {
        for (const batch of part.foliage?.batches ?? []) { add(batch.modelGuid); add(batch.materialGuid); }
      }
    }
    if (command.overlayPanel) {
      add(command.overlayPanel.source === "texture" ? command.overlayPanel.textureGuid : command.overlayPanel.materialGuid);
    }
    for (const guid of Object.values(command.skybox?.faces ?? {})) add(guid);
  }
  return [...guids].sort();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Source preparation was cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
