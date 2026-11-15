import { isOk, type ProjectStorage, type SourceControlMode, type SourceControlProjectSettings } from "@haptic/core";
import {
  credentialHasHostApi,
  FakeLockProvider,
  GitLfsLockProvider,
  LOCK_POLL_INTERVAL_MS,
  LockPollScheduler,
  isSourceControlHost,
  parseGitConfigPrefill,
  parseRepositoryUrl,
  type CredentialKind,
  type CredentialSource,
  type FileLock,
  type GitConfigPrefill,
  type HostCredential,
  type HttpClient,
  type LockProvider,
} from "@haptic/source-control";

export type DocumentLockEditMode = "editable" | "readonly" | "edit-anyway";

/** Verify requests one refresh sends while local lock changes keep overtaking the reply. */
const MAX_OVERTAKEN_VERIFY_ATTEMPTS = 3;

/** Why a lock change waits in Integrated mode before the checked-out branch is known. */
const LOCK_BRANCH_UNKNOWN = "Locks wait until the repository opens: each lock names the checked-out branch.";

/**
 * The device's credentials and native HTTP. The editor loads them only when
 * a project's mode is not Off; tests pass their own.
 */
export interface SourceControlHosts {
  /** The origin's credential for requests: refreshed before it expires and renewed after a 401. */
  credentialSource(origin: string): CredentialSource;
  readonly http: HttpClient | null;
  /** Called after a credential is saved or removed. */
  subscribe(listener: () => void): () => void;
}

/** What the signed-out banner names and where its Sign In leads. */
export interface SourceControlSignInPrompt {
  origin: string;
  /** `github.com` and `gitlab.com` sign in on the device; any other host takes a token in Engine Settings. */
  deviceHost: "github" | "gitlab" | null;
  label: string;
}

export interface LockRefreshState {
  status: "idle" | "refreshing" | "ready" | "error";
  error: string | null;
  lastSuccessAt: number | null;
}

export interface PushedCheckState {
  status: "idle" | "checking" | "ready" | "error";
  error: string | null;
  /** Own locked paths whose local file matches the remote branch, from the last check. */
  pushed: ReadonlySet<string>;
}

export type DocumentLockBanner =
  | { kind: "theirs"; lock: FileLock }
  | { kind: "unlocked"; message: string };

export interface SourceControlConfigureInput {
  settings: SourceControlProjectSettings;
  /** The open project; a different one drops the old provider's locks. */
  projectKey: string | null;
  platform: string;
  testMode: boolean;
  /** Defaults to the device accounts, loaded on first use. */
  hosts?: SourceControlHosts;
  /** The project's files and unsaved state, for Release Pushed Locks. */
  storage?: ProjectStorage | null;
  isPathDirty?: (path: string) => boolean;
  /** Test seam: a provider the tests seed before configuring; the editor never passes one. */
  fake?: FakeLockProvider;
}

const NO_PUSHED: ReadonlySet<string> = new Set();
const IDLE_PUSHED: PushedCheckState = { status: "idle", error: null, pushed: NO_PUSHED };

function loadDeviceHosts(testMode: boolean): Promise<SourceControlHosts> {
  return import("./source-control-accounts").then((module) => module.sourceControlAccounts(testMode));
}

export function signInPromptFor(origin: string): SourceControlSignInPrompt {
  if (origin === "https://github.com") return { origin, deviceHost: "github", label: "GitHub" };
  if (origin === "https://gitlab.com") return { origin, deviceHost: "gitlab", label: "GitLab" };
  return { origin, deviceHost: null, label: new URL(origin).host };
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SourceControlService {
  private settings: SourceControlProjectSettings = {
    mode: "off",
    repositoryUrl: "",
    branch: "main",
    autoLockOnEdit: true,
    releaseLocksAfterPush: true,
  };
  private hostOk = false;
  private testMode = false;
  /**
   * The working copy's checked-out branch in Integrated mode (the sync's
   * HEAD); `""` while it is not known (the Git client has not opened, or could
   * not); null where Haptic runs no Git client (a blocked folder).
   */
  private checkedOut: string | null = "";
  /** Paths edited while the checked-out branch was not known, auto-locked once it is. */
  private heldAutoLocks = new Set<string>();
  /** The branch the last lock requests named, so a move checks the locks again. */
  private lastLockBranch: string | null = null;
  /** The branch `locksByPath` was listed for. */
  private listBranch: string | null = null;
  /**
   * This device's own locks on branches lock requests no longer name (an
   * Integrated copy moved off them), by branch: a host that scopes locks by
   * ref lists them only there, and they must stay in view and releasable.
   */
  private otherBranchLocks = new Map<string, FileLock[]>();
  /** Branches moved off whose own locks the next check lists, once per move. */
  private branchesLeft = new Set<string>();
  private hosts: SourceControlHosts | null = null;
  private detachHosts: (() => void) | null = null;
  private storage: ProjectStorage | null = null;
  private isPathDirty: (path: string) => boolean = () => false;
  private seededFake: FakeLockProvider | null = null;
  private provider: LockProvider | null = null;
  private fake: FakeLockProvider | null = null;
  private credentialKind: CredentialKind | null = null;
  /** The credential the provider was built with; a different one (another account, a new token) rebuilds it. */
  private credentialKey: string | null = null;
  private scheduler: LockPollScheduler | null = null;
  /** Host visibility from pausePolling / resumePolling, kept for schedulers created later. */
  private pollingPaused = false;
  private locksByPath = new Map<string, FileLock>();
  private locksSnapshot: FileLock[] | null = null;
  private editMode = new Map<string, DocumentLockEditMode>();
  private autoLockAttempted = new Set<string>();
  private banners = new Map<string, DocumentLockBanner>();
  private listeners = new Set<() => void>();
  private providerIdentity = "";
  private refreshRevision = 0;
  private providerRevision = 0;
  private configureRevision = 0;
  /** Bumped whenever a create or unlock reply changes `locksByPath`, so a verify that predates it is not applied. */
  private lockMutations = 0;
  private lockRefreshState: LockRefreshState = { status: "idle", error: null, lastSuccessAt: null };
  private lastOperationError: string | null = null;
  private signInPrompt: SourceControlSignInPrompt | null = null;
  private unsupported = false;
  private pushedState: PushedCheckState = IDLE_PUSHED;
  private pushedRevision = 0;

  get refreshState(): Readonly<LockRefreshState> {
    return this.lockRefreshState;
  }

  get operationError(): string | null {
    return this.lastOperationError;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get mode(): SourceControlMode {
    return this.active ? this.settings.mode : "off";
  }

  /** The project's mode is not Off on a host with source control: the tab, banner and lock state exist. */
  get active(): boolean {
    return this.hostOk && this.settings.mode !== "off";
  }

  /** Locks are live: active, signed in and a provider built. */
  get enabled(): boolean {
    return this.active && this.provider !== null;
  }

  get autoLockOnEdit(): boolean {
    return this.settings.autoLockOnEdit;
  }

  /**
   * The branch lock requests name. Integrated mode: the working copy's
   * checked-out branch, the one a push sends, so a host that scopes locks by
   * ref checks that branch. Manual mode and a folder Haptic runs no Git client
   * in (blocked: another Git app owns HEAD) use the project's default branch.
   * While an Integrated copy's branch is not known (`lockBranchKnown`), checks
   * list the default branch's locks, and lock changes wait.
   */
  get lockBranch(): string {
    return this.settings.mode === "integrated" && this.checkedOut ? this.checkedOut : this.settings.branch;
  }

  /**
   * False in Integrated mode until the sync knows the checked-out branch (the
   * Git client opens in the seconds after the project, or could not): a lock
   * made or released then would name the default branch while HEAD may be
   * another. Auto-lock waits for it (`heldAutoLocks`); a Release says why.
   */
  get lockBranchKnown(): boolean {
    return this.settings.mode !== "integrated" || this.checkedOut !== "";
  }

  /**
   * The working copy's checked-out branch, from the Integrated sync: `""`
   * while it is not known, null where Haptic runs no Git client (a blocked
   * folder). A move checks the locks again, since a host that scopes them by
   * ref lists another branch's, and lets auto-lock try each path again.
   */
  setCheckedOutBranch(branch: string | null): void {
    this.checkedOut = branch;
    this.followLockBranch();
  }

  /**
   * A move keeps the own locks of the branch left in view at once (from the
   * list, when it is that branch's) and has the next check list that
   * branch's own locks once, so they stay releasable where a host scopes
   * locks by ref; moving back lists them as the branch's own again.
   */
  private followLockBranch(): void {
    const branch = this.lockBranch;
    const left = this.lastLockBranch;
    if (branch !== left) {
      this.lastLockBranch = branch;
      if (left !== null && this.provider && this.active && !this.unsupported) {
        if (this.listBranch === left) this.keepOtherBranch(left, this.locks.filter((lock) => lock.ours && lock.branch === undefined));
        this.otherBranchLocks.delete(branch);
        this.branchesLeft.delete(branch);
        this.branchesLeft.add(left);
        this.locksSnapshot = null;
        this.autoLockAttempted.clear();
        this.emit();
        this.requestRefresh();
      }
    }
    if (this.lockBranchKnown && this.heldAutoLocks.size > 0) {
      const held = [...this.heldAutoLocks];
      this.heldAutoLocks.clear();
      for (const path of held) void this.autoLock(path);
    }
  }

  /** Lock changes wait while an Integrated copy's branch is not known: says why, and whether to wait. */
  private waitForLockBranch(): boolean {
    if (this.lockBranchKnown) return false;
    this.lastOperationError = LOCK_BRANCH_UNKNOWN;
    this.emit();
    return true;
  }

  /** Set while the project's host has no credential on this device; nothing is requested until one is saved. */
  get signIn(): SourceControlSignInPrompt | null {
    return this.active ? this.signInPrompt : null;
  }

  /** The host answered the lock endpoints with 404 or 501. */
  get lockingUnsupported(): boolean {
    return this.unsupported;
  }

  /** Release Pushed Locks: Manual mode on a host whose REST API Haptic uses (GitHub, GitLab). */
  get canReleasePushed(): boolean {
    return this.enabled && !this.unsupported && this.settings.mode === "manual" &&
      this.credentialKind !== null && credentialHasHostApi(this.credentialKind);
  }

  get pushedCheck(): PushedCheckState {
    return this.pushedState;
  }

  /**
   * The branch's locks, then this device's own on branches it moved off
   * (`FileLock.branch`; one a host that ignores refs lists for both appears
   * once). Stable until the lists change, so a panel re-rendering for
   * another reason keeps its rows.
   */
  get locks(): FileLock[] {
    if (!this.locksSnapshot) {
      const listed = [...this.locksByPath.values()];
      const ids = new Set(listed.map((lock) => lock.id));
      for (const locks of this.otherBranchLocks.values()) {
        for (const lock of locks) {
          if (ids.has(lock.id)) continue;
          ids.add(lock.id);
          listed.push(lock);
        }
      }
      this.locksSnapshot = listed;
    }
    return this.locksSnapshot;
  }

  /** `locks` are this device's own on `branch`, which lock requests no longer name. */
  private keepOtherBranch(branch: string, locks: readonly FileLock[]): void {
    if (locks.length > 0) this.otherBranchLocks.set(branch, locks.map((lock) => ({ ...lock, branch })));
    else this.otherBranchLocks.delete(branch);
    this.locksSnapshot = null;
  }

  get heldCount(): number {
    return this.locks.filter((lock) => lock.ours).length;
  }

  get fakeProvider(): FakeLockProvider | null {
    return this.fake;
  }

  lockForPath(path: string): FileLock | undefined {
    return this.locksByPath.get(path);
  }

  isDocumentReadOnly(path: string): boolean {
    if (!this.active) return false;
    return this.editMode.get(path) === "readonly";
  }

  bannerFor(path: string): DocumentLockBanner | null {
    return this.banners.get(path) ?? null;
  }

  lockStateForPath(path: string): "mine" | "theirs" | null {
    if (!this.active) return null;
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
    if (!this.active) return;
    const lock = this.locksByPath.get(path);
    if (lock && !lock.ours && this.editMode.get(path) !== "edit-anyway") {
      this.editMode.set(path, "readonly");
      this.banners.set(path, { kind: "theirs", lock });
      this.emit();
    }
  }

  /**
   * Mode Off returns before touching credentials, HTTP or timers. Otherwise the
   * repository's origin must have a credential on this device; without one the
   * service shows the sign-in prompt and requests nothing until one is saved.
   */
  async configure(input: SourceControlConfigureInput): Promise<void> {
    const configureRevision = ++this.configureRevision;
    const wasActive = this.active;
    this.settings = { ...input.settings };
    this.hostOk = isSourceControlHost(input.platform, input.testMode);
    this.testMode = input.testMode;
    this.storage = input.storage ?? null;
    this.isPathDirty = input.isPathDirty ?? (() => false);
    if (!this.active) {
      this.scheduler?.stop();
      this.refreshRevision += 1;
      this.providerRevision += 1;
      this.pushedRevision += 1;
      this.lockRefreshState = { ...this.lockRefreshState, status: "idle", error: null };
      if (wasActive) this.emit();
      return;
    }
    const identity = [
      input.settings.repositoryUrl,
      input.settings.branch,
      input.projectKey ?? "",
      input.testMode ? "t" : "",
      input.fake ? "fake" : "",
    ].join("|");
    if (identity === this.providerIdentity && this.hosts) {
      // Manual and Integrated name different branches.
      this.followLockBranch();
      // A credential saved or removed while the mode was Off applies now.
      await this.connect();
      if (configureRevision !== this.configureRevision) return;
      if (this.provider && !this.unsupported) {
        this.scheduler ??= this.createScheduler();
        this.scheduler.start();
      }
      this.emit();
      return;
    }
    this.providerIdentity = identity;
    this.seededFake = input.fake ?? null;
    this.resetProviderState();
    // The new provider's first check names the branch it starts on.
    this.lastLockBranch = this.lockBranch;
    this.emit();
    let hosts: SourceControlHosts;
    try {
      hosts = input.hosts ?? await loadDeviceHosts(input.testMode);
    } catch (error) {
      if (configureRevision !== this.configureRevision) return;
      this.lockRefreshState = { ...this.lockRefreshState, status: "error", error: message(error) };
      this.emit();
      return;
    }
    if (configureRevision !== this.configureRevision) return;
    if (hosts !== this.hosts) {
      this.detachHosts?.();
      this.hosts = hosts;
      this.detachHosts = hosts.subscribe(() => void this.connect());
    }
    await this.connect();
  }

  /** Builds the provider once the repository's origin has a credential, or shows the sign-in prompt. */
  private async connect(): Promise<void> {
    const hosts = this.hosts;
    if (!hosts || !this.active) return;
    const revision = this.providerRevision;
    const location = parseRepositoryUrl(this.settings.repositoryUrl);
    if (!location) {
      // Project Settings refuses an empty repository; there is nothing to sign in to.
      this.dropProvider(null);
      this.emit();
      return;
    }
    const source = hosts.credentialSource(location.origin);
    let credential: HostCredential | null;
    try {
      credential = await source.current();
    } catch (error) {
      if (revision !== this.providerRevision) return;
      this.lockRefreshState = { ...this.lockRefreshState, status: "error", error: message(error) };
      this.emit();
      return;
    }
    if (revision !== this.providerRevision) return;
    if (!credential) {
      this.dropProvider(signInPromptFor(location.origin));
      this.emit();
      return;
    }
    this.signInPrompt = null;
    // The account, not the token, so a refreshed GitLab token keeps the provider and its locks.
    const credentialKey = `${credential.kind}\n${credential.username}\n${credential.account ?? credential.token}`;
    if (this.provider && credentialKey === this.credentialKey) {
      this.emit();
      return;
    }
    // Another account may see what this one could not (a 404 also reads as no locking).
    if (this.provider) this.resetProviderState();
    this.credentialKind = credential.kind;
    this.credentialKey = credentialKey;
    if (this.seededFake) {
      this.fake = this.seededFake;
      this.provider = this.seededFake;
    } else if (this.testMode) {
      this.fake = new FakeLockProvider({ selfName: credential.account ?? "Me" });
      this.provider = this.fake;
    } else if (hosts.http) {
      try {
        this.provider = new GitLfsLockProvider({
          repositoryUrl: this.settings.repositoryUrl,
          branch: () => this.lockBranch,
          http: hosts.http,
          credential: source,
        });
      } catch {
        this.provider = null;
      }
    }
    if (this.provider) {
      this.scheduler = this.createScheduler();
      this.scheduler.start();
    }
    this.emit();
  }

  private resetProviderState(): void {
    this.lastOperationError = null;
    this.refreshRevision += 1;
    this.providerRevision += 1;
    this.pushedRevision += 1;
    this.lockRefreshState = { status: "idle", error: null, lastSuccessAt: null };
    this.scheduler?.stop();
    this.scheduler = null;
    this.provider = null;
    this.fake = null;
    this.credentialKind = null;
    this.credentialKey = null;
    this.signInPrompt = null;
    this.unsupported = false;
    this.pushedState = IDLE_PUSHED;
    this.setLocks([]);
    this.listBranch = this.lockBranch;
    this.otherBranchLocks.clear();
    this.branchesLeft.clear();
    // The old provider's locks are gone, so their read-only tabs and banners go
    // too, even when the new provider never refreshes.
    this.reconcileDocumentLockState();
    this.autoLockAttempted.clear();
    this.heldAutoLocks.clear();
  }

  /** A removed credential (Sign Out) stops every request until a new one is saved. */
  private dropProvider(prompt: SourceControlSignInPrompt | null): void {
    if (this.provider) this.resetProviderState();
    this.signInPrompt = prompt;
  }

  dispose(): void {
    this.configureRevision += 1;
    this.detachHosts?.();
    this.detachHosts = null;
    this.hosts = null;
    this.providerIdentity = "";
    this.resetProviderState();
    this.settings = { ...this.settings, mode: "off" };
    this.editMode.clear();
    this.banners.clear();
    this.emit();
  }

  /**
   * The tick returns the refresh so the scheduler never overlaps two, and a
   * scheduler created while the host is hidden starts paused.
   */
  private createScheduler(): LockPollScheduler {
    const scheduler = new LockPollScheduler({
      intervalMs: LOCK_POLL_INTERVAL_MS,
      tick: () => this.refresh(),
    });
    if (this.pollingPaused) scheduler.pause();
    return scheduler;
  }

  pausePolling(): void {
    this.pollingPaused = true;
    this.scheduler?.pause();
  }

  resumePolling(): void {
    this.pollingPaused = false;
    this.scheduler?.resume();
  }

  requestRefresh(): void {
    if (this.scheduler) this.scheduler.requestImmediate();
    else void this.refresh();
  }

  async refresh(): Promise<void> {
    const provider = this.provider;
    if (!provider || !this.active || this.unsupported) return;
    const revision = ++this.refreshRevision;
    const before = this.lockRefreshState;
    this.lockRefreshState = { ...this.lockRefreshState, status: "refreshing", error: null };
    this.emit();
    try {
      let result;
      let mutations;
      let branch;
      let attempts = 0;
      // The server may have answered before a lock this editor created or
      // released meanwhile; that list would revive or drop it, so ask again.
      do {
        mutations = this.lockMutations;
        branch = this.lockBranch;
        result = await provider.verify({ branch });
        if (revision !== this.refreshRevision) return;
        attempts += 1;
      } while (isOk(result) && mutations !== this.lockMutations && attempts < MAX_OVERTAKEN_VERIFY_ATTEMPTS);
      if (isOk(result) && mutations !== this.lockMutations) {
        // A burst of local lock changes keeps overtaking the list: keep the
        // cached locks and leave the next check to the scheduler, which runs
        // it after this tick (or on resume) without holding up its ticks.
        this.lockRefreshState = before.status === "refreshing"
          ? { ...before, status: before.lastSuccessAt === null ? "idle" : "ready" }
          : before;
        this.emit();
        this.scheduler?.requestImmediate();
        return;
      }
      if (!isOk(result)) {
        if (result.error.kind === "unsupported") {
          this.markUnsupported();
          return;
        }
        this.lockRefreshState = {
          ...this.lockRefreshState,
          status: "error",
          error: result.error.message || "Could not refresh locks. Check the connection and Source Control in Engine Settings.",
        };
      } else {
        this.setLocks([...result.value.ours, ...result.value.theirs]);
        this.listBranch = branch;
        this.reconcileDocumentLockState();
        this.lockRefreshState = { status: "ready", error: null, lastSuccessAt: Date.now() };
        if (!(await this.listBranchesLeft(provider, revision))) return;
      }
    } catch (error) {
      if (revision !== this.refreshRevision) return;
      this.lockRefreshState = {
        ...this.lockRefreshState,
        status: "error",
        error: message(error),
      };
    }
    this.emit();
  }

  /**
   * Lists this device's own locks on each branch moved off since the last
   * check, once per move (a failed listing keeps those already in view).
   * False when a newer check or provider took over meanwhile.
   */
  private async listBranchesLeft(provider: LockProvider, revision: number): Promise<boolean> {
    for (const branch of [...this.branchesLeft]) {
      this.branchesLeft.delete(branch);
      if (branch === this.lockBranch) continue;
      const mutations = this.lockMutations;
      const listed = await provider.verify({ branch });
      if (revision !== this.refreshRevision) return false;
      // A release meanwhile would come back to life in that list.
      if (isOk(listed) && mutations === this.lockMutations && branch !== this.lockBranch) this.keepOtherBranch(branch, listed.value.ours);
    }
    return true;
  }

  /** No locking API: stop polling and auto-lock; the Locks window says so instead of an error. */
  private markUnsupported(): void {
    this.unsupported = true;
    this.scheduler?.stop();
    this.scheduler = null;
    this.lockRefreshState = { ...this.lockRefreshState, status: "idle", error: null };
    this.emit();
  }

  async autoLock(path: string): Promise<void> {
    if (!this.active || !this.settings.autoLockOnEdit || !this.provider || this.unsupported) {
      return;
    }
    const held = this.locksByPath.get(path);
    if (held?.ours) {
      this.autoLockAttempted.add(path);
      // Every applied edit lands here once the lock is ours; notify only
      // when the banner or edit mode actually changes.
      const changed =
        this.banners.delete(path) || this.editMode.get(path) !== "editable";
      this.editMode.set(path, "editable");
      if (changed) this.emit();
      return;
    }
    if (this.autoLockAttempted.has(path)) return;
    if (!this.lockBranchKnown) {
      this.heldAutoLocks.add(path);
      return;
    }
    this.autoLockAttempted.add(path);
    const revision = this.providerRevision;
    let result;
    try { result = await this.provider.create(path); }
    catch (error) {
      if (revision !== this.providerRevision) return;
      this.banners.set(path, { kind: "unlocked", message: message(error) });
      this.emit();
      return;
    }
    if (revision !== this.providerRevision) return;
    if (isOk(result)) {
      this.setLock(path, result.value);
      this.banners.delete(path);
      this.editMode.set(path, "editable");
      this.emit();
      return;
    }
    if (result.error.kind === "unsupported") {
      this.markUnsupported();
      return;
    }
    if (result.error.kind === "conflict" && result.error.lock) {
      const lock = result.error.lock;
      this.setLock(path, lock);
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
    if (!this.active) return null;
    const lock = this.locksByPath.get(path);
    if (lock && !lock.ours) {
      return `Locked by ${lock.ownerName}`;
    }
    return null;
  }

  async transferLock(oldPath: string, newPath: string): Promise<void> {
    const provider = this.provider;
    const revision = this.providerRevision;
    if (!provider || !this.active) return;
    const existing = this.locksByPath.get(oldPath);
    if (!existing?.ours) return;
    if (this.waitForLockBranch()) throw new Error(LOCK_BRANCH_UNKNOWN);
    this.lastOperationError = null;
    // Lock the moved path before releasing the old one: a failed create keeps
    // the user's lock held rather than releasing it remotely.
    let lock: FileLock;
    try {
      const created = await provider.create(newPath);
      if (revision !== this.providerRevision) return;
      if (!isOk(created)) throw new Error(created.error.message || "Could not lock the moved asset.");
      lock = created.value;
    } catch (error) {
      if (revision !== this.providerRevision) return;
      const text = `Could not transfer the lock to ${newPath}: ${message(error)}`;
      this.autoLockAttempted.delete(newPath);
      this.banners.set(newPath, { kind: "unlocked", message: text });
      this.lastOperationError = text;
      this.emit();
      throw new Error(text, { cause: error });
    }
    this.setLock(newPath, lock);
    this.banners.delete(newPath);
    this.editMode.set(newPath, "editable");
    this.autoLockAttempted.add(newPath);
    try {
      const released = await provider.unlock(existing.id);
      if (revision !== this.providerRevision) return;
      if (!isOk(released)) throw new Error(released.error.message || "Could not release the old lock.");
    } catch (error) {
      if (revision !== this.providerRevision) return;
      // The moved asset stays locked; the old path's lock stays listed to release later.
      const text = `Could not release the lock on ${oldPath}: ${message(error)}`;
      this.lastOperationError = text;
      this.emit();
      throw new Error(text, { cause: error });
    }
    this.deleteLock(oldPath);
    this.autoLockAttempted.delete(oldPath);
    this.banners.delete(oldPath);
    this.editMode.delete(oldPath);
    this.emit();
  }

  async releasePath(path: string): Promise<void> {
    const lock = this.locksByPath.get(path);
    if (!lock?.ours) return;
    await this.release(lock.id);
  }

  async release(id: string): Promise<void> {
    if (!this.provider || this.waitForLockBranch()) return;
    const revision = this.providerRevision;
    this.lastOperationError = null;
    this.emit();
    const error = await this.releaseLock(id);
    if (revision !== this.providerRevision) return;
    this.lastOperationError = error;
    this.emit();
  }

  async releaseAllMine(): Promise<void> {
    await this.releaseEach(this.locks.filter((lock) => lock.ours));
  }

  async forceUnlock(id: string): Promise<void> {
    if (!this.provider || this.waitForLockBranch()) return;
    const revision = this.providerRevision;
    this.lastOperationError = null;
    this.emit();
    const error = await this.releaseLock(id, true);
    if (revision !== this.providerRevision) return;
    this.lastOperationError = error;
    this.emit();
  }

  /**
   * Reads the remote branch once and compares it with the files of our own
   * locks, each hashed once. A path the remote listing lacks (or cut short)
   * reads as Not Pushed.
   */
  async checkPushed(): Promise<ReadonlySet<string> | null> {
    if (!this.canReleasePushed || !this.hosts || !this.storage) return null;
    const hosts = this.hosts;
    const storage = this.storage;
    const location = parseRepositoryUrl(this.settings.repositoryUrl);
    if (!location || !hosts.http) return null;
    const revision = ++this.pushedRevision;
    const paths = this.locks.filter((lock) => lock.ours).map((lock) => lock.path);
    this.pushedState = { ...this.pushedState, status: "checking", error: null };
    this.emit();
    try {
      const source = hosts.credentialSource(location.origin);
      const credential = await source.current();
      if (!credential) throw new Error("Sign in to check pushed files.");
      const { pushedLockPaths } = await import("./source-control-pushed");
      const pushed = await pushedLockPaths({
        credential,
        source,
        http: hosts.http,
        repositoryPath: location.path,
        branch: this.settings.branch,
        paths,
        storage,
      });
      if (revision !== this.pushedRevision) return null;
      this.pushedState = { status: "ready", error: null, pushed };
      this.emit();
      return pushed;
    } catch (error) {
      if (revision !== this.pushedRevision) return null;
      this.pushedState = { status: "error", error: message(error), pushed: NO_PUSHED };
      this.emit();
      return null;
    }
  }

  /**
   * Integrated push: the locks someone else holds on `paths` of `branch`,
   * the branch the push sends (checked out when it runs), from a fresh
   * verify. Empty where there is nothing to check against (no provider yet,
   * or a host without the locking API), so locking never blocks a push it
   * cannot judge; a failed verify rejects.
   */
  async locksBlockingPush(paths: readonly string[], branch: string): Promise<FileLock[]> {
    const provider = this.provider;
    if (!this.active || !provider || this.unsupported || paths.length === 0) return [];
    const revision = this.providerRevision;
    const result = await provider.verify({ branch });
    if (!isOk(result)) {
      if (result.error.kind === "unsupported") {
        if (revision === this.providerRevision) this.markUnsupported();
        return [];
      }
      throw new Error(result.error.message || "Could not check the locks on what this push sends.");
    }
    const wanted = new Set(paths);
    return result.value.theirs.filter((lock) => wanted.has(lock.path));
  }

  /** Release Locks After Push: this device's locks on `paths`, except documents with unsaved edits. */
  async releaseOwnLocks(paths: readonly string[]): Promise<void> {
    const wanted = new Set(paths);
    const locks = this.locks.filter((lock) => lock.ours && wanted.has(lock.path) && !this.isPathDirty(lock.path));
    if (locks.length > 0) await this.releaseEach(locks);
  }

  /** Whether the open document at `path` has unsaved edits; Release Pushed Locks leaves its lock. */
  hasUnsavedEdits(path: string): boolean {
    return this.isPathDirty(path);
  }

  /** Re-checks at click time, then releases our pushed locks, skipping documents with unsaved edits. */
  async releasePushedMine(): Promise<void> {
    const pushed = await this.checkPushed();
    if (!pushed) return;
    await this.releaseEach(this.locks.filter((lock) => lock.ours && pushed.has(lock.path) && !this.isPathDirty(lock.path)));
  }

  private async releaseEach(locks: FileLock[]): Promise<void> {
    if (!this.provider || this.waitForLockBranch()) return;
    const revision = this.providerRevision;
    this.lastOperationError = null;
    this.emit();
    const errors: string[] = [];
    for (const lock of locks) {
      if (revision !== this.providerRevision) return;
      const error = await this.releaseLock(lock.id);
      if (error) errors.push(`${lock.path}: ${error}`);
    }
    if (revision !== this.providerRevision) return;
    this.lastOperationError = errors.length ? errors.join("; ") : null;
    this.emit();
  }

  private async releaseLock(id: string, force = false): Promise<string | null> {
    const provider = this.provider;
    const revision = this.providerRevision;
    if (!provider) return "Source control is unavailable.";
    // A lock of a branch moved off is released on its own branch.
    const branch = this.locks.find((lock) => lock.id === id)?.branch;
    try {
      const result = await provider.unlock(id, { ...(force ? { force: true } : {}), ...(branch ? { branch } : {}) });
      if (!isOk(result)) return result.error.message || "Could not release the lock. Try again.";
      if (revision === this.providerRevision) this.removeLockId(id);
      return null;
    } catch (error) {
      return message(error);
    }
  }

  private removeLockId(id: string): void {
    for (const [branch, locks] of this.otherBranchLocks) {
      if (!locks.some((lock) => lock.id === id)) continue;
      this.keepOtherBranch(branch, locks.filter((lock) => lock.id !== id));
      this.lockMutations += 1;
    }
    for (const [path, lock] of this.locksByPath) {
      if (lock.id === id) {
        this.deleteLock(path);
        this.autoLockAttempted.delete(path);
        this.editMode.delete(path);
        this.banners.delete(path);
      }
    }
  }

  /** Keeps the previous object for an unchanged lock, so a poll that changes nothing re-renders no row. */
  private setLocks(locks: FileLock[]): void {
    const previous = this.locksByPath;
    this.locksByPath = new Map(locks.map((lock) => {
      const old = previous.get(lock.path);
      const same = old && old.id === lock.id && old.ownerName === lock.ownerName && old.lockedAt === lock.lockedAt && old.ours === lock.ours;
      return [lock.path, same ? old : lock];
    }));
    this.locksSnapshot = null;
  }

  private setLock(path: string, lock: FileLock): void {
    this.locksByPath.set(path, lock);
    this.locksSnapshot = null;
    this.lockMutations += 1;
  }

  private deleteLock(path: string): void {
    this.locksByPath.delete(path);
    this.locksSnapshot = null;
    this.lockMutations += 1;
  }

  /** Verified lock changes must not leave a former owner's edit restriction behind. */
  private reconcileDocumentLockState(): void {
    for (const [path, mode] of this.editMode) {
      const lock = this.locksByPath.get(path);
      const banner = this.banners.get(path);
      if (lock && !lock.ours) {
        if (banner?.kind === "theirs") {
          this.banners.set(path, { kind: "theirs", lock });
        }
        continue;
      }
      if (mode === "readonly") this.editMode.delete(path);
      if (banner?.kind === "theirs") this.banners.delete(path);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
