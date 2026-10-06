import type { SaveGameDefinition, SaveGameStorage } from "./save-game";

/** Serializable boot settings shared by editor Play and the exported player. */
export interface SaveGameConfiguration {
  projectId: string;
  definition: SaveGameDefinition;
  preview?: boolean;
  defaultProfile?: string;
  defaultSlot?: string;
}

export interface SaveStorageRequest {
  id: number;
  operation: "read" | "write" | "remove" | "list" | "acquire" | "release" | "persist";
  key: string;
  text?: string;
}
export interface SaveStorageResponse {
  id: number;
  value?: unknown;
  error?: { name: string; message: string; code?: string };
}

/** The worker stays platform-neutral; storage and native detection stay in its host. */
export function createSaveStorageClient(send: (request: SaveStorageRequest) => void) {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  function request(operation: SaveStorageRequest["operation"], key = "", text?: string): Promise<unknown> {
    if (closed) return Promise.reject(new Error("Save storage session closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { send({ id, operation, key, text }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  const storage: SaveGameStorage = {
    read: async (key) => await request("read", key) as string | null,
    write: async (key, text) => { await request("write", key, text); },
    remove: async (key) => { await request("remove", key); },
    list: async (key) => await request("list", key) as string[],
    requestPersistence: async () => await request("persist") as boolean,
    async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const token = await request("acquire", key) as string;
      try { return await operation(); }
      finally { await request("release", token); }
    },
  };
  return {
    storage,
    receive(response: SaveStorageResponse) {
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (response.error) waiter.reject(Object.assign(new Error(response.error.message), response.error));
      else waiter.resolve(response.value);
    },
    dispose() {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error("Save storage session closed"));
      pending.clear();
    },
  };
}

/** Each worker owns its locks; termination releases them without a stale lease timeout. */
export function createSaveStorageServer(storage: SaveGameStorage, reply: (response: SaveStorageResponse) => void) {
  let closed = false;
  const locks = new Map<string, () => void>();
  const operations = new Set<Promise<void>>();
  async function execute(request: SaveStorageRequest): Promise<unknown> {
    if (closed) throw new Error("Save storage session closed");
    switch (request.operation) {
      case "read": return storage.read(request.key);
      case "write": return storage.write(request.key, request.text ?? "");
      case "remove": return storage.remove(request.key);
      case "list": return storage.list(request.key);
      case "persist": return storage.requestPersistence?.() ?? false;
      case "release": {
        const release = locks.get(request.key);
        locks.delete(request.key);
        release?.();
        return;
      }
      case "acquire": return new Promise<string>((resolve, reject) => {
        void storage.withLock(request.key, async () => {
          if (closed) throw new Error("Save storage session closed");
          const token = String(request.id);
          await new Promise<void>((release) => {
            locks.set(token, release);
            resolve(token);
          });
        }).catch(reject);
      });
    }
  }
  return {
    receive(request: SaveStorageRequest) {
      const operation = execute(request).then(
        (value) => { if (!closed) reply({ id: request.id, value }); },
        (error: unknown) => {
          const value = error as { name?: string; message?: string; code?: string };
          if (!closed) reply({ id: request.id, error: { name: value?.name ?? "Error", message: value?.message ?? String(error), code: value?.code } });
        },
      );
      if (request.operation !== "acquire") operations.add(operation);
      void operation.finally(() => operations.delete(operation));
    },
    dispose() {
      closed = true;
      // Let any in-flight write finish before allowing another writer into its lock.
      void Promise.allSettled([...operations]).then(() => {
        for (const release of locks.values()) release();
        locks.clear();
      });
    },
  };
}
