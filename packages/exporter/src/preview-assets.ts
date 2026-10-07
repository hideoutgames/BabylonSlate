/** Preview transports only requested files; delivery archives remain in the host. */
export const PREVIEW_ASSET_REQUEST = "babylonslate-preview-asset-request";
export const PREVIEW_ASSET_RESPONSE = "babylonslate-preview-asset-response";
type AssetRequest = { type: typeof PREVIEW_ASSET_REQUEST; requestId: number; path: string };
type AssetResponse = { type: typeof PREVIEW_ASSET_RESPONSE; requestId: number; bytes?: ArrayBuffer; error?: string };

export function createPreviewAssetServer(options: {
  files: ReadonlyMap<string, Uint8Array>;
  send: (message: AssetResponse, transfer: Transferable[]) => void;
}) {
  let disposed = false;
  return {
    /** Caller validates the window source and origin before forwarding data. */
    receive(value: unknown): boolean {
      const request = value as Partial<AssetRequest> | null;
      if (request?.type !== PREVIEW_ASSET_REQUEST) return false;
      if (disposed || !Number.isSafeInteger(request.requestId) || typeof request.path !== "string") return true;
      const bytes = options.files.get(request.path);
      const requestId = request.requestId!;
      if (!bytes) options.send({ type: PREVIEW_ASSET_RESPONSE, requestId, error: `Preview asset file ${request.path} is missing.` }, []);
      else {
        const copy = bytes.slice().buffer;
        options.send({ type: PREVIEW_ASSET_RESPONSE, requestId, bytes: copy }, [copy]);
      }
      return true;
    },
    dispose() { disposed = true; },
  };
}

export function createPreviewAssetClient(options: {
  send: (message: AssetRequest) => void;
  timeoutMs?: number;
}) {
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: unknown) => void }>();
  return {
    readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
      if (disposed || signal.aborted) return Promise.reject(signal.reason ?? new Error("Preview asset source is closed."));
      return new Promise((resolve, reject) => {
        const requestId = ++nextId;
        const cleanup = () => { pending.delete(requestId); clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const abort = () => fail(signal.reason ?? new Error("Preview asset request was cancelled."));
        const timer = setTimeout(() => fail(new Error(`Preview asset ${path} did not respond before its deadline.`)), options.timeoutMs ?? 30_000);
        pending.set(requestId, { resolve: bytes => { cleanup(); resolve(bytes); }, reject: fail });
        signal.addEventListener("abort", abort, { once: true });
        try { options.send({ type: PREVIEW_ASSET_REQUEST, requestId, path }); } catch (error) { fail(error); }
      });
    },
    /** Caller validates the window source and origin before forwarding data. */
    receive(value: unknown): boolean {
      const response = value as Partial<AssetResponse> | null;
      if (response?.type !== PREVIEW_ASSET_RESPONSE) return false;
      const request = pending.get(response.requestId!);
      if (!request) return true;
      if (typeof response.error === "string") request.reject(new Error(response.error));
      else if (response.bytes instanceof ArrayBuffer) request.resolve(new Uint8Array(response.bytes));
      else request.reject(new Error("Preview returned an invalid asset response."));
      return true;
    },
    dispose() {
      disposed = true;
      for (const request of pending.values()) request.reject(new Error("Preview asset source is closed."));
      pending.clear();
    },
  };
}
