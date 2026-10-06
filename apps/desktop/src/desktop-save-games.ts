import { randomUUID } from "node:crypto";
import { NodeSaveGameStorage } from "@babylonslate/vfs/save-game-node";

type Result<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string; code?: string } };
interface Lease {
  owner: number;
  key: string;
  release: () => void;
  pending: Set<Promise<unknown>>;
  closing: boolean;
}

/** Main-process lease ownership prevents another window from releasing an active transaction. */
export class DesktopSaveGames {
  private readonly leases = new Map<string, Lease>();
  private readonly epochs = new Map<number, number>();
  constructor(private readonly storage: NodeSaveGameStorage) {}

  async result<T>(operation: () => Promise<T>): Promise<Result<T>> {
    try { return { ok: true, value: await operation() }; }
    catch (error) {
      const details = error as { name?: unknown; message?: unknown; code?: unknown } | null;
      return { ok: false, error: {
        name: String(details?.name ?? "Error"), message: String(details?.message ?? "Save storage failed"),
        ...(typeof details?.code === "string" ? { code: details.code } : {}),
      } };
    }
  }

  async acquire(owner: number, key: string): Promise<string> {
    const epoch = this.epochs.get(owner) ?? 0;
    const release = await this.storage.acquireLock(key);
    if ((this.epochs.get(owner) ?? 0) !== epoch) {
      release();
      throw new Error("Save request owner closed");
    }
    const token = randomUUID();
    this.leases.set(token, { owner, key, release, pending: new Set(), closing: false });
    return token;
  }

  async release(owner: number, token: string): Promise<void> {
    const lease = this.leases.get(token);
    if (!lease || lease.owner !== owner) throw new Error("Invalid save lock owner");
    lease.closing = true;
    await Promise.allSettled(lease.pending);
    this.leases.delete(token);
    lease.release();
  }

  async releaseOwner(owner: number): Promise<void> {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    await Promise.all([...this.leases].filter(([, lease]) => lease.owner === owner).map(([token]) => this.release(owner, token)));
  }

  private async operation<T>(owner: number, key: string, run: () => Promise<T>): Promise<T> {
    const lease = [...this.leases.values()].find(lease => lease.owner === owner && !lease.closing &&
      (key === lease.key || key.startsWith(`${lease.key}/`)));
    if (!lease) throw new Error("Save storage access requires an owned lock");
    const pending = run();
    lease.pending.add(pending);
    try { return await pending; } finally { lease.pending.delete(pending); }
  }

  read(owner: number, key: string): Promise<string | null> { return this.operation(owner, key, () => this.storage.read(key)); }
  write(owner: number, key: string, text: string): Promise<void> { return this.operation(owner, key, () => this.storage.write(key, text)); }
  remove(owner: number, key: string): Promise<void> { return this.operation(owner, key, () => this.storage.remove(key)); }
  list(owner: number, key: string): Promise<string[]> { return this.operation(owner, key, () => this.storage.list(key)); }
}
