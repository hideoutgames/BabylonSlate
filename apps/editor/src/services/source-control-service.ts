import { isOk, type SourceControlProjectSettings } from "@babylonslate/core";
import type { ProjectStorage } from "@babylonslate/core";
import {
  FakeLockProvider,
  GitLfsLockProvider,
  LockPollScheduler,
  isSourceControlHost,
  parseGitConfigPrefill,
  sourceControlSecretKey,
  type FileLock,
  type GitConfigPrefill,
  type LockProvider,
} from "@babylonslate/source-control";
import type { NativeHttp } from "@babylonslate/vfs";
import type { SecretStore } from "@babylonslate/vfs";

export type DocumentLockEditMode = "editable" | "readonly" | "edit-anyway";

export type DocumentLockBanner =
  | { kind: "theirs"; lock: FileLock }
  | { kind: "unlocked"; message: string };

export interface SourceControlConfigureInput {
  settings: SourceControlProjectSettings;
  projectGuid: string | null;
  platform: string;
  testMode: boolean;
  secretStore: SecretStore;
  nativeHttp: NativeHttp | null;
  fake?: FakeLockProvider;
}

export async function readGitPrefill(
  storage: ProjectStorage,
): Promise<GitConfigPrefill> {
  if (!(await storage.exists(".git/config"))) {
    return { repositoryUrl: "", branch: "" };
  }
  const config = await storage.readText(".git/config");
  let head: string | null = null;
  if (await storage.exists(".git/HEAD")) {
    head = await storage.readText(".git/HEAD");
  }
  return parseGitConfigPrefill(config, head);
}

export function formatLockAge(lockedAt: string, nowMs = Date.now()): string {
  const then = Date.parse(lockedAt);
  if (!Number.isFinite(then)) return "Unknown Age";
  const delta = Math.max(0, nowMs - then);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "Just Now";
  if (minutes < 60) return `${minutes} Min Ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} Hr Ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 Day Ago" : `${days} Days Ago`;
}

export class SourceControlService {
  private settings: SourceControlProjectSettings = {
    enabled: false,
    repositoryUrl: "",
    branch: "main",
    autoLockOnEdit: true,
    pollIntervalMs: 60_000,
  };
  private projectGuid: string | null = null;
  private secretStore: SecretStore | null = null;
  private provider: LockProvider | null = null;
  private fake: FakeLockProvider | null = null;
  private scheduler: LockPollScheduler | null = null;
  private locksByPath = new Map<string, FileLock>();
  private editMode = new Map<string, DocumentLockEditMode>();
  private autoLockAttempted = new Set<string>();
  private banners = new Map<string, DocumentLockBanner>();
  private tokenSaved = false;
  private listeners = new Set<() => void>();
  private testMode = false;
  private providerIdentity = "";

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get enabled(): boolean {
    return this.settings.enabled && this.provider !== null;
  }

  get settingsEnabled(): boolean {
    return this.settings.enabled;
  }

  get autoLockOnEdit(): boolean {
    return this.settings.autoLockOnEdit;
  }

  get locks(): FileLock[] {
    return [...this.locksByPath.values()];
  }

  get heldCount(): number {
    return this.locks.filter((lock) => lock.ours).length;
  }

  get hasToken(): boolean {
    return this.tokenSaved;
  }

  get fakeProvider(): FakeLockProvider | null {
    return this.fake;
  }

  lockForPath(path: string): FileLock | undefined {
    return this.locksByPath.get(path);
  }

  isDocumentReadOnly(path: string): boolean {
    if (!this.settings.enabled) return false;
    return this.editMode.get(path) === "readonly";
  }

  bannerFor(path: string): DocumentLockBanner | null {
    return this.banners.get(path) ?? null;
  }

  lockStateForPath(path: string): "mine" | "theirs" | null {
    if (!this.settings.enabled) return null;
    const lock = this.locksByPath.get(path);
    if (!lock) return null;
    return lock.ours ? "mine" : "theirs";
  }

  setEditAnyway(path: string): void {
    this.editMode.set(path, "edit-anyway");
    const lock = this.locksByPath.get(path);
    if (lock && !lock.ours) {
      this.banners.set(path, { kind: "theirs", lock });
    }
    this.emit();
  }

  onOpenDocument(path: string): void {
    if (!this.settings.enabled) return;
    const lock = this.locksByPath.get(path);
    if (lock && !lock.ours && this.editMode.get(path) !== "edit-anyway") {
      this.editMode.set(path, "readonly");
      this.banners.set(path, { kind: "theirs", lock });
      this.emit();
    }
  }

  async configure(input: SourceControlConfigureInput): Promise<void> {
    const identity = [
      input.settings.enabled ? "1" : "0",
      input.settings.repositoryUrl,
      input.settings.branch,
      String(input.settings.pollIntervalMs),
      input.projectGuid ?? "",
      input.testMode ? "t" : "",
      input.fake ? "fake" : input.nativeHttp ? "http" : "",
    ].join("|");
    this.settings = { ...input.settings };
    this.projectGuid = input.projectGuid;
    this.secretStore = input.secretStore;
    this.testMode = input.testMode;
    if (identity === this.providerIdentity && this.provider) {
      this.emit();
      return;
    }
    this.providerIdentity = identity;
    this.scheduler?.stop();
    this.scheduler = null;
    this.provider = null;
    this.fake = null;
    this.locksByPath.clear();
    this.autoLockAttempted.clear();
    if (!this.settings.enabled) {
      this.editMode.clear();
      this.banners.clear();
      this.emit();
      return;
    }
    const hostOk = isSourceControlHost(input.platform, input.testMode);
    if (!hostOk) {
      this.emit();
      return;
    }
    this.tokenSaved = Boolean(
      input.projectGuid &&
        (await input.secretStore.get(sourceControlSecretKey(input.projectGuid))),
    );
    if (input.fake) {
      this.fake = input.fake;
      this.provider = input.fake;
    } else if (input.testMode) {
      this.fake = new FakeLockProvider({ selfName: "Me" });
      this.provider = this.fake;
    } else if (input.nativeHttp && this.settings.repositoryUrl) {
      try {
        this.provider = new GitLfsLockProvider({
          repositoryUrl: this.settings.repositoryUrl,
          branch: this.settings.branch,
          fetch: input.nativeHttp,
          getToken: async () => {
            if (!this.projectGuid || !this.secretStore) return null;
            return this.secretStore.get(sourceControlSecretKey(this.projectGuid));
          },
        });
      } catch {
        this.provider = null;
      }
    }
    if (this.provider) {
      this.scheduler = new LockPollScheduler({
        intervalMs: this.settings.pollIntervalMs,
        tick: () => {
          void this.refresh();
        },
      });
      this.scheduler.start();
    }
    this.emit();
  }

  dispose(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.provider = null;
    this.fake = null;
    this.providerIdentity = "";
    this.locksByPath.clear();
    this.editMode.clear();
    this.banners.clear();
    this.autoLockAttempted.clear();
    this.emit();
  }

  pausePolling(): void {
    this.scheduler?.pause();
  }

  resumePolling(): void {
    this.scheduler?.resume();
  }

  requestRefresh(): void {
    this.scheduler?.requestImmediate();
    if (!this.scheduler) void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.provider) return;
    const result = await this.provider.verify();
    if (!isOk(result)) return;
    this.locksByPath.clear();
    for (const lock of [...result.value.ours, ...result.value.theirs]) {
      this.locksByPath.set(lock.path, lock);
    }
    this.emit();
  }

  async saveToken(token: string): Promise<void> {
    if (!this.projectGuid || !this.secretStore) return;
    await this.secretStore.set(sourceControlSecretKey(this.projectGuid), token);
    this.tokenSaved = true;
    this.emit();
  }

  async clearToken(): Promise<void> {
    if (!this.projectGuid || !this.secretStore) return;
    await this.secretStore.delete(sourceControlSecretKey(this.projectGuid));
    this.tokenSaved = false;
    this.emit();
  }

  async autoLock(path: string): Promise<void> {
    if (!this.settings.enabled || !this.settings.autoLockOnEdit || !this.provider) {
      return;
    }
    if (this.autoLockAttempted.has(path)) return;
    this.autoLockAttempted.add(path);
    const result = await this.provider.create(path);
    if (isOk(result)) {
      this.locksByPath.set(path, result.value);
      this.banners.delete(path);
      this.editMode.set(path, "editable");
      this.emit();
      return;
    }
    if (result.error.kind === "conflict" && result.error.lock) {
      const lock = result.error.lock;
      this.locksByPath.set(path, lock);
      if (lock.ours) {
        this.banners.delete(path);
        this.editMode.set(path, "editable");
      } else {
        this.banners.set(path, {
          kind: "unlocked",
          message: `Locked by ${lock.ownerName}. Editing anyway.`,
        });
      }
      this.emit();
      return;
    }
    this.banners.set(path, {
      kind: "unlocked",
      message: result.error.message || "Could not lock this asset.",
    });
    this.emit();
  }

  refuseIfTheirs(path: string): string | null {
    if (!this.settings.enabled) return null;
    const lock = this.locksByPath.get(path);
    if (lock && !lock.ours) {
      return `Locked by ${lock.ownerName}`;
    }
    return null;
  }

  async transferLock(oldPath: string, newPath: string): Promise<void> {
    if (!this.provider) return;
    const existing = this.locksByPath.get(oldPath);
    if (!existing?.ours) return;
    await this.provider.unlock(existing.id);
    this.locksByPath.delete(oldPath);
    const created = await this.provider.create(newPath);
    if (isOk(created)) {
      this.locksByPath.set(newPath, created.value);
    }
    this.autoLockAttempted.delete(oldPath);
    this.autoLockAttempted.add(newPath);
    this.emit();
  }

  async release(id: string): Promise<void> {
    if (!this.provider) return;
    const result = await this.provider.unlock(id);
    if (isOk(result)) {
      this.removeLockId(id);
      this.emit();
    }
  }

  async releaseAllMine(): Promise<void> {
    if (!this.provider) return;
    const mine = this.locks.filter((lock) => lock.ours);
    for (const lock of mine) {
      const result = await this.provider.unlock(lock.id);
      if (isOk(result)) this.removeLockId(lock.id);
    }
    this.emit();
  }

  async forceUnlock(id: string): Promise<void> {
    if (!this.provider) return;
    const result = await this.provider.unlock(id, { force: true });
    if (isOk(result)) {
      this.removeLockId(id);
      this.emit();
    }
  }

  private removeLockId(id: string): void {
    for (const [path, lock] of this.locksByPath) {
      if (lock.id === id) {
        this.locksByPath.delete(path);
        this.autoLockAttempted.delete(path);
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
