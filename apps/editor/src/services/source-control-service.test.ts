import { describe, expect, it, vi } from "vitest";
import { err, type SourceControlProjectSettings } from "@haptic/core";
import { FakeLockProvider, type HostCredential, type HttpClient } from "@haptic/source-control";
import { FakeGitHost, MemorySecrets } from "@haptic/source-control/fake-host";
import { MemoryStorageAdapter } from "@haptic/vfs";
import {
  MANUAL_SOURCE_CONTROL as manual,
  signedInHosts as signedIn,
  TEST_GITHUB_CREDENTIAL as GITHUB,
} from "../testing/source-control-hosts";
import { SourceControlAccounts } from "./source-control-accounts";
import {
  SourceControlService,
  type SourceControlHosts,
} from "./source-control-service";

describe("SourceControlService", () => {
  it("does nothing at all while the mode is Off: no credentials, network, timers or notifications", async () => {
    vi.useFakeTimers();
    const service = new SourceControlService();
    const credentialFor = vi.fn(async () => GITHUB);
    const subscribe = vi.fn(() => () => {});
    const http = vi.fn();
    const hosts: SourceControlHosts = {
      credentialSource: () => ({ current: credentialFor, renew: credentialFor }),
      subscribe,
      http,
    };
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify");
    const listener = vi.fn();
    service.subscribe(listener);
    try {
      for (const platform of ["electron", "ios", "web"]) {
        await service.configure({ settings: { ...manual, mode: "off" }, projectKey: "proj", platform, testMode: true, hosts, fake });
      }
      await service.onEdit("assets/a.hasset");
      service.requestRefresh();
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
      expect(credentialFor).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect([service.active, service.enabled, service.signIn, service.mode]).toEqual([false, false, null, "off"]);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("asks to sign in and requests nothing until the repository's host has a credential, then starts locking", async () => {
    vi.useFakeTimers();
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify");
    const accounts = await signedIn(null, null);
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake });
      expect(service.signIn).toEqual({ origin: "https://github.com", deviceHost: "github", label: "GitHub", reason: "signed-out" });
      expect(service.enabled).toBe(false);
      await service.onEdit("assets/a.hasset");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(verify).not.toHaveBeenCalled();
      expect(fake.snapshot()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      // A credential for another host never satisfies this repository.
      await accounts.save({ ...GITHUB, origin: "https://gitlab.com", kind: "gitlab", username: "oauth2" });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.signIn?.origin).toBe("https://github.com");

      await accounts.save(GITHUB);
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      expect(service.signIn).toBeNull();
      expect(verify).toHaveBeenCalledTimes(1);
      // Polling runs on the fixed 60 s interval.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(verify).toHaveBeenCalledTimes(2);

      // Signing out stops every request and brings the prompt back.
      await accounts.remove("https://github.com");
      await vi.waitFor(() => expect(service.signIn?.label).toBe("GitHub"));
      expect(service.enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("names a token host in the prompt and never offers device sign-in for it", async () => {
    const service = new SourceControlService();
    try {
      await service.configure({
        settings: { ...manual, repositoryUrl: "git@gitea.example.com:team/game.git" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(),
      });
      expect(service.signIn).toEqual({ origin: "https://gitea.example.com", deviceHost: null, label: "gitea.example.com", reason: "signed-out" });
    } finally { service.dispose(); }
  });

  it("sends Git LFS requests with the stored credential's username, only to its origin", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const http: HttpClient = async (request) => {
      requests.push({ url: request.url, authorization: request.headers.Authorization });
      return { status: 200, bodyText: '{"ours":[],"theirs":[]}' };
    };
    const gitlab: HostCredential = { origin: "https://gitlab.com", username: "oauth2", token: "glo", kind: "gitlab" };
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({
        settings: { ...manual, repositoryUrl: "https://gitlab.com/group/game.git" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http, gitlab),
      });
      await service.refresh();
      expect(requests).toEqual([
        { url: "https://gitlab.com/group/game.git/info/lfs/locks/verify", authorization: `Basic ${btoa("oauth2:glo")}` },
      ]);
    } finally { service.dispose(); }
  });

  it("stops polling and auto-lock when the host has no locking API", async () => {
    vi.useFakeTimers();
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify").mockResolvedValue(err({ kind: "unsupported", message: "This Host Does Not Support File Locking.", status: 404 }));
    const create = vi.spyOn(fake, "create");
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await vi.waitFor(() => expect(service.lockingUnsupported).toBe(true));
      expect(service.refreshState.error).toBeNull();
      expect(service.canReleasePushed).toBe(false);
      await service.onEdit("assets/a.hasset");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(service.bannerFor("assets/a.hasset")).toBeNull();
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("applies a sign-in or sign-out made while the mode was Off when it comes back", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const accounts = await signedIn();
    const config = { settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake };
    service.pausePolling();
    try {
      await service.configure(config);
      expect(service.enabled).toBe(true);
      await service.configure({ ...config, settings: { ...manual, mode: "off" as const } });
      await accounts.remove("https://github.com");
      await service.configure(config);
      expect(service.enabled).toBe(false);
      expect(service.signIn?.label).toBe("GitHub");
      await service.configure({ ...config, settings: { ...manual, mode: "off" as const } });
      await accounts.save(GITHUB);
      await service.configure(config);
      expect(service.signIn).toBeNull();
      expect(service.enabled).toBe(true);
    } finally { service.dispose(); }
  });

  it("brings the sign-in banner back when a GitLab sign-in can no longer be refreshed", async () => {
    let now = 1_000_000;
    const host = new FakeGitHost();
    const accounts = new SourceControlAccounts(new MemorySecrets(), host.http, { clientId: () => "client", now: () => now });
    // A refresh token the host no longer accepts (spent, or revoked on gitlab.com).
    await accounts.save({ origin: "https://gitlab.com", username: "oauth2", token: "fake-gitlab-token", kind: "gitlab", account: "ada", refreshToken: "revoked", expiresAt: now + 3_600_000 });
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({
        settings: { ...manual, repositoryUrl: "https://gitlab.com/group/game.git" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: accounts,
      });
      expect(service.enabled).toBe(true);
      // The next lock check finds the token expiring and the refresh rejected.
      now += 3_600_000;
      await service.refresh();
      await vi.waitFor(() => expect(service.signIn?.label).toBe("GitLab"));
      expect(service.enabled).toBe(false);
      expect(await accounts.list()).toEqual([]);
    } finally { service.dispose(); }
  });

  it("checks the saved sign-in once as the project opens, asks to sign in again when the host refuses it, and stops asking once it is replaced", async () => {
    const host = new FakeGitHost();
    const accounts = new SourceControlAccounts(new MemorySecrets(), host.http, { clientId: () => "client" });
    await accounts.save({ origin: "https://github.com", username: "x-access-token", token: "fake-old", kind: "github", account: "ada" });
    host.refusedTokens.add("fake-old");
    const service = new SourceControlService();
    service.pausePolling();
    const checks = () => host.requests.filter((request) => request.url === "https://api.github.com/user").length;
    try {
      const config = { settings: manual, projectKey: "proj", platform: "electron", testMode: false, hosts: accounts };
      await service.configure(config);
      await vi.waitFor(() => expect(service.signIn).toEqual({ origin: "https://github.com", deviceHost: "github", label: "GitHub", reason: "refused" }));
      await service.configure({ ...config, settings: { ...manual, mode: "off" as const } });
      await service.configure(config);
      expect(checks()).toBe(1);

      await accounts.save({ origin: "https://github.com", username: "x-access-token", token: "fake-new", kind: "github", account: "ada" });
      await vi.waitFor(() => expect(service.signIn).toBeNull());
      expect(service.enabled).toBe(true);
      await vi.waitFor(() => expect(checks()).toBe(2));
      expect(service.signIn).toBeNull();
    } finally { service.dispose(); }
  });

  it("says a GitHub sign-in whose expiry passed has expired, without asking the host", async () => {
    const host = new FakeGitHost();
    const now = 1_000_000;
    const accounts = new SourceControlAccounts(new MemorySecrets(), host.http, { clientId: () => "client", now: () => now });
    await accounts.save({ origin: "https://github.com", username: "x-access-token", token: "fake-1", kind: "github", account: "ada", expiresAt: now - 1 });
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: false, hosts: accounts });
      expect(service.signIn).toEqual({ origin: "https://github.com", deviceHost: "github", label: "GitHub", reason: "expired" });
      expect(host.requests.filter((request) => request.url === "https://api.github.com/user")).toEqual([]);
    } finally { service.dispose(); }
  });

  it("keeps checking a GitHub repository that answers 404 rather than calling it unsupported", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const http: HttpClient = async (request) => {
      requests.push(request.url);
      return { status: 404, bodyText: JSON.stringify({ message: "Not Found" }) };
    };
    const service = new SourceControlService();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http) });
      await vi.waitFor(() => expect(service.refreshState.error).toBe("Repository Not Found Or No Access"));
      expect(service.lockingUnsupported).toBe(false);
      await service.onEdit("assets/a.hasset");
      await vi.advanceTimersByTimeAsync(60_000);
      // The create and the next scheduled check both went out.
      expect(requests.filter((url) => url.endsWith("/locks/verify"))).toHaveLength(2);
      expect(requests.filter((url) => url.endsWith("/locks"))).toHaveLength(1);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("tries again with a newly saved credential after the host reported no locking API", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify").mockResolvedValueOnce(err({ kind: "unsupported", message: "Not Found", status: 404 }));
    const accounts = await signedIn();
    service.pausePolling();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake });
      await service.refresh();
      expect(service.lockingUnsupported).toBe(true);
      // The same credential saved again changes nothing.
      await accounts.save({ ...GITHUB });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      expect(service.lockingUnsupported).toBe(true);
      // Another account may see the repository the first could not.
      await accounts.save({ ...GITHUB, token: "other-account", account: "bea" });
      await vi.waitFor(() => expect(service.lockingUnsupported).toBe(false));
      await service.refresh();
      expect(service.refreshState.status).toBe("ready");
      expect(verify).toHaveBeenCalledTimes(2);
    } finally { service.dispose(); }
  });

  it("keeps each unchanged lock object across a refresh, so the Locks rows do not re-render", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/a.hasset", "Bob", "2026-08-15T12:00:00Z");
    fake.addTheirs("assets/b.hasset", "Bob", "2026-08-15T12:00:00Z");
    service.pausePolling();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await service.refresh();
      const [a, b] = [service.lockForPath("assets/a.hasset"), service.lockForPath("assets/b.hasset")];
      const snapshot = service.locks;
      expect(service.locks).toBe(snapshot);
      await fake.unlock(b!.id, { force: true });
      fake.addTheirs("assets/b.hasset", "Cy", "2026-08-15T13:00:00Z");
      await service.refresh();
      expect(service.lockForPath("assets/a.hasset")).toBe(a);
      expect(service.lockForPath("assets/b.hasset")).not.toBe(b);
      expect(service.lockForPath("assets/b.hasset")?.ownerName).toBe("Cy");
      expect(service.locks).not.toBe(snapshot);
    } finally { service.dispose(); }
  });

  it("releases only our locks whose files match the remote branch, skipping unsaved documents", async () => {
    const host = new FakeGitHost();
    const storage = new MemoryStorageAdapter();
    await storage.openDocumentsProject("game");
    const pushedBytes = new Uint8Array([1, 2, 3]);
    await storage.writeBinary("assets/pushed.hasset", pushedBytes);
    await storage.writeBinary("assets/dirty.hasset", pushedBytes);
    await storage.writeBinary("assets/changed.hasset", new Uint8Array([9]));
    await storage.writeBinary("assets/new.hasset", pushedBytes);
    // `git hash-object` of the bytes 01 02 03.
    const blob = "aed2973e4b8a7ff1b30ff5c4751e5a2b38989e74";
    host.remoteBlobs.set("assets/pushed.hasset", blob);
    host.remoteBlobs.set("assets/dirty.hasset", blob);
    host.remoteBlobs.set("assets/changed.hasset", blob);
    host.remoteBlobs.set("assets/theirs.hasset", blob);
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/theirs.hasset", "Bob");
    const service = new SourceControlService();
    try {
      await service.configure({
        settings: manual, projectKey: "proj", platform: "electron", testMode: true,
        hosts: await signedIn(host.http), fake, storage,
        isPathDirty: (path) => path === "assets/dirty.hasset",
      });
      service.pausePolling();
      // Manual mode has no Git client here: the remote branch compared is always the default one.
      service.setCheckedOutBranch("feature");
      for (const path of ["assets/pushed.hasset", "assets/dirty.hasset", "assets/changed.hasset", "assets/new.hasset"]) await service.onEdit(path);
      await service.refresh();
      expect(service.canReleasePushed).toBe(true);
      const checked = await service.checkPushed();
      expect([...checked!].sort()).toEqual(["assets/dirty.hasset", "assets/pushed.hasset"]);
      // One tree request per check.
      expect(host.requests.filter((request) => request.url.includes("/git/trees/")).map((request) => request.url)).toEqual([
        "https://api.github.com/repos/org/repo/git/trees/main?recursive=1",
      ]);
      await service.releasePushedMine();
      expect(fake.snapshot().map((lock) => lock.path).sort()).toEqual([
        "assets/changed.hasset", "assets/dirty.hasset", "assets/new.hasset", "assets/theirs.hasset",
      ]);
      expect(service.lockForPath("assets/pushed.hasset")).toBeUndefined();
    } finally { service.dispose(); }
  });

  it("keeps a lock scheduler created while polling is paused from polling until resumed", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify");
    try {
      service.pausePolling();
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(verify).not.toHaveBeenCalled();
      service.resumePolling();
      await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    } finally { service.dispose(); }
  });

  it("does not revive a disposed service when its credential lookup finishes", async () => {
    const service = new SourceControlService();
    const accounts = await signedIn();
    let finish!: (value: HostCredential | null) => void;
    const lookup = new Promise<HostCredential | null>((resolve) => { finish = resolve; });
    vi.spyOn(accounts, "credentialSource").mockReturnValueOnce({ current: () => lookup, renew: async () => null });
    const fake = new FakeLockProvider();
    const verify = vi.spyOn(fake, "verify");
    const pending = service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake });
    service.dispose();
    finish(GITHUB);
    await pending;
    expect(service.enabled).toBe(false);
    expect(service.refreshState.status).toBe("idle");
    expect(verify).not.toHaveBeenCalled();
  });

  it("keeps the newer provider when configuration lookups finish out of order", async () => {
    const service = new SourceControlService();
    const accounts = await signedIn();
    let finish!: (value: HostCredential | null) => void;
    const lookup = new Promise<HostCredential | null>((resolve) => { finish = resolve; });
    vi.spyOn(accounts, "credentialSource").mockReturnValueOnce({ current: () => lookup, renew: async () => null });
    const first = new FakeLockProvider();
    const second = new FakeLockProvider();
    const config = { settings: manual, projectKey: "first", platform: "electron", testMode: true, hosts: accounts, fake: first };
    try {
      const pending = service.configure(config);
      await service.configure({ ...config, projectKey: "second", fake: second });
      service.pausePolling();
      finish(GITHUB);
      await pending;
      await service.onEdit("assets/current.hasset");
      expect(first.snapshot()).toEqual([]);
      expect(second.snapshot().map((lock) => lock.path)).toEqual(["assets/current.hasset"]);
    } finally { service.dispose(); }
  });

  it("keeps the old lock when locking the moved path fails, and permits locking it later", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      service.pausePolling();
      await service.onEdit("assets/old.hasset");
      const unlock = vi.spyOn(fake, "unlock");
      vi.spyOn(fake, "create").mockResolvedValueOnce(err({ kind: "offline", message: "Connection lost" }));
      await expect(service.transferLock("assets/old.hasset", "assets/new.hasset")).rejects.toThrow("Connection lost");
      expect(service.operationError).toContain("Connection lost");
      expect(service.bannerFor("assets/new.hasset")?.kind).toBe("unlocked");
      expect(unlock).not.toHaveBeenCalled();
      expect(service.lockForPath("assets/old.hasset")?.ours).toBe(true);
      await service.onEdit("assets/new.hasset");
      expect(service.lockForPath("assets/new.hasset")?.ours).toBe(true);
      expect(service.bannerFor("assets/new.hasset")).toBeNull();
    } finally { service.dispose(); }
  });

  it("keeps the moved path locked when releasing the old lock fails", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      service.pausePolling();
      await service.onEdit("assets/old.hasset");
      vi.spyOn(fake, "unlock").mockResolvedValueOnce(err({ kind: "offline", message: "Connection lost" }));
      await expect(service.transferLock("assets/old.hasset", "assets/new.hasset")).rejects.toThrow("Connection lost");
      expect(service.operationError).toContain("assets/old.hasset");
      expect(service.lockForPath("assets/new.hasset")?.ours).toBe(true);
      expect(service.bannerFor("assets/new.hasset")).toBeNull();
      expect(service.lockForPath("assets/old.hasset")?.ours).toBe(true);
    } finally { service.dispose(); }
  });

  it("keeps a lock transfer that finishes while an older lock list is still on its way", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      service.pausePolling();
      await service.onEdit("assets/old.hasset");
      // The server answers verify with the locks it held before the transfer.
      const beforeTransfer = await fake.verify();
      let answer!: () => void;
      vi.spyOn(fake, "verify").mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve(beforeTransfer); }));
      const refreshing = service.refresh();
      await service.transferLock("assets/old.hasset", "assets/new.hasset");
      answer();
      await refreshing;
      expect(service.lockStateForPath("assets/new.hasset")).toBe("mine");
      expect(service.lockForPath("assets/old.hasset")).toBeUndefined();
      expect(service.refreshState.status).toBe("ready");
    } finally { service.dispose(); }
  });

  it("stops asking for the lock list while a burst of local lock changes overtakes it, and polls again", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      service.pausePolling();
      // A folder move locks its assets one after another, each while a lock list is on its way.
      let movesLeft = 20;
      const verify = fake.verify.bind(fake);
      vi.spyOn(fake, "verify").mockImplementation(async () => {
        const reply = await verify();
        if (movesLeft > 0) await service.onEdit(`assets/moved-${movesLeft--}.hasset`);
        return reply;
      });

      await service.refresh();
      expect(movesLeft).toBeGreaterThan(0);
      expect(service.lockStateForPath(`assets/moved-${movesLeft + 1}.hasset`)).toBe("mine");
      expect(service.refreshState.status).not.toBe("refreshing");

      service.resumePolling();
      await vi.waitFor(() => {
        expect(movesLeft).toBe(0);
        expect(service.refreshState.status).toBe("ready");
      });
      expect(fake.snapshot().map((lock) => service.lockStateForPath(lock.path))).toEqual(Array(20).fill("mine"));
    } finally { service.dispose(); }
  });

  it("ignores an old unlock failure after switching projects", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/hero.scene.hasset", "Ada");
    const config = { settings: manual, projectKey: "first", platform: "electron", testMode: true, hosts: await signedIn(), fake };
    await service.configure(config);
    service.pausePolling();
    try {
      await service.refresh();
      const lock = service.locks[0]!;
      let finish!: (value: Awaited<ReturnType<typeof fake.unlock>>) => void;
      vi.spyOn(fake, "unlock").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = service.forceUnlock(lock.id);
      await service.configure({ ...config, projectKey: "second", fake: new FakeLockProvider() });
      service.pausePolling();
      finish(err({ kind: "http", status: 403, message: "Old project token rejected" }));
      await pending;
      expect(service.operationError).toBeNull();
      expect(service.locks).toHaveLength(0);
    } finally { service.dispose(); }
  });

  it("does not reuse an old project's pending auto-lock for the same path in a new project", async () => {
    const service = new SourceControlService();
    const first = new FakeLockProvider({ selfName: "First Project" });
    const second = new FakeLockProvider({ selfName: "Second Project" });
    const path = "assets/hero.scene.hasset";
    const config = { settings: manual, projectKey: "first", platform: "electron", testMode: true, hosts: await signedIn(), fake: first };
    const createFirstLock = first.create.bind(first);
    let finish!: () => void;
    const response = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(first, "create").mockImplementationOnce(async (requestedPath) => {
      await response;
      return createFirstLock(requestedPath);
    });
    try {
      await service.configure(config);
      service.pausePolling();
      const pending = service.onEdit(path);
      service.dispose();
      await service.configure({ ...config, projectKey: "second", fake: second });
      service.pausePolling();
      finish();
      await pending;
      expect(service.lockForPath(path)).toBeUndefined();
      expect(service.bannerFor(path)).toBeNull();
      await service.onEdit(path);
      expect(service.lockForPath(path)?.ownerName).toBe("Second Project");
      expect(second.snapshot()).toMatchObject([{ path, ours: true }]);
    } finally { service.dispose(); }
  });

  it("explains a rejected unlock without removing the cached lock", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/hero.scene.hasset", "Ada");
    await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
    service.pausePolling();
    try {
      await service.refresh();
      const lock = service.lockForPath("assets/hero.scene.hasset")!;
      service.onOpenDocument(lock.path);
      expect(service.isDocumentReadOnly(lock.path)).toBe(true);
      const unlock = vi.spyOn(fake, "unlock").mockResolvedValueOnce(err({ kind: "http", status: 403, message: "No permission to unlock" }));
      await service.forceUnlock(lock.id);
      expect(service.operationError).toBe("No permission to unlock");
      expect(service.lockForPath(lock.path)).toEqual(lock);
      expect(service.isDocumentReadOnly(lock.path)).toBe(true);
      expect(service.bannerFor(lock.path)?.kind).toBe("theirs");
      unlock.mockRestore();
      await service.forceUnlock(lock.id);
      expect(service.operationError).toBeNull();
      expect(service.lockForPath(lock.path)).toBeUndefined();
      expect(service.isDocumentReadOnly(lock.path)).toBe(false);
      expect(service.bannerFor(lock.path)).toBeNull();
    } finally { service.dispose(); }
  });
  it("reports a failed refresh, preserves cached locks, and clears the error after retry", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/hero.scene.hasset", "Ada");
    await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
    service.pausePolling();
    try {
      await service.refresh();
      expect(service.refreshState.status).toBe("ready");
      service.onOpenDocument("assets/hero.scene.hasset");
      const lastSuccess = service.refreshState.lastSuccessAt;
      const verify = vi.spyOn(fake, "verify").mockResolvedValueOnce(err({ kind: "http", status: 401, message: "Token expired" }));
      await service.refresh();
      expect(service.refreshState).toEqual({ status: "error", error: "Token expired", lastSuccessAt: lastSuccess });
      expect(service.locks).toHaveLength(1);
      expect(service.isDocumentReadOnly("assets/hero.scene.hasset")).toBe(true);
      expect(service.bannerFor("assets/hero.scene.hasset")?.kind).toBe("theirs");
      await service.refresh();
      expect(service.refreshState.status).toBe("ready");
      expect(service.refreshState.error).toBeNull();
      verify.mockRestore();
    } finally { service.dispose(); }
  });

  it.each(["unlocked", "ours"] as const)("restores editing when refresh confirms a former owner's lock is %s", async (state) => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const path = "assets/hero.scene.hasset";
    const oldLock = fake.addTheirs(path, "Ada");
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      service.pausePolling();
      await service.refresh();
      service.onOpenDocument(path);
      expect(service.isDocumentReadOnly(path)).toBe(true);
      await fake.unlock(oldLock.id, { force: true });
      if (state === "ours") await fake.create(path);
      await service.refresh();
      expect(service.isDocumentReadOnly(path)).toBe(false);
      expect(service.bannerFor(path)).toBeNull();
      service.onOpenDocument(path);
      expect(service.isDocumentReadOnly(path)).toBe(false);
      expect(service.lockStateForPath(path)).toBe(state === "ours" ? "mine" : null);
    } finally { service.dispose(); }
  });
  it("auto-locks on first edit and skips a second attempt", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "web",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.onEdit("assets/hero.scene.hasset");
    await service.onEdit("assets/hero.scene.hasset");
    expect(service.lockForPath("assets/hero.scene.hasset")?.ours).toBe(true);
    expect(fake.snapshot()).toHaveLength(1);
    expect(service.lockStateForPath("assets/hero.scene.hasset")).toBe("mine");
  });

  it("does not notify subscribers on later edits once the lock is already ours", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "web",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    service.pausePolling();
    try {
      await service.refresh();
      await service.onEdit("assets/hero.scene.hasset");
      const listener = vi.fn();
      service.subscribe(listener);
      await service.onEdit("assets/hero.scene.hasset");
      await service.onEdit("assets/hero.scene.hasset");
      expect(listener).not.toHaveBeenCalled();
      expect(service.lockStateForPath("assets/hero.scene.hasset")).toBe("mine");
    } finally {
      service.dispose();
    }
  });

  it("notifies subscribers when an edit on a held lock clears its banner", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "web",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    service.pausePolling();
    try {
      vi.spyOn(fake, "create").mockResolvedValueOnce(
        err({ kind: "http", status: 503, message: "Offline" }),
      );
      await service.onEdit("assets/hero.scene.hasset");
      expect(service.bannerFor("assets/hero.scene.hasset")?.kind).toBe("unlocked");
      await fake.create("assets/hero.scene.hasset");
      await service.refresh();
      const listener = vi.fn();
      service.subscribe(listener);
      await service.onEdit("assets/hero.scene.hasset");
      expect(listener).toHaveBeenCalledOnce();
      expect(service.bannerFor("assets/hero.scene.hasset")).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("opens theirs read-only until Edit Anyway", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/hero.scene.hasset", "Bob");
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.refresh();
    service.onOpenDocument("assets/hero.scene.hasset");
    expect(service.isDocumentReadOnly("assets/hero.scene.hasset")).toBe(true);
    expect(service.bannerFor("assets/hero.scene.hasset")?.kind).toBe("theirs");
    service.setEditAnyway("assets/hero.scene.hasset");
    await service.refresh();
    expect(service.isDocumentReadOnly("assets/hero.scene.hasset")).toBe(false);
    expect(service.bannerFor("assets/hero.scene.hasset")).toMatchObject({ kind: "theirs", lock: { ownerName: "Bob" } });
    service.dispose();
  });

  it("lifts a read-only tab when the repository changes and the new host has no credential", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/hero.scene.hasset", "Bob");
    const hosts = await signedIn();
    const config = { settings: manual, projectKey: "proj", platform: "electron", testMode: true, hosts, fake };
    try {
      await service.configure(config);
      service.pausePolling();
      await service.refresh();
      service.onOpenDocument("assets/hero.scene.hasset");
      expect(service.isDocumentReadOnly("assets/hero.scene.hasset")).toBe(true);
      // The new host has no credential, so no refresh reconciles the tab.
      await service.configure({ ...config, settings: { ...manual, repositoryUrl: "https://changed.example/repo" } });
      expect(service.signIn?.origin).toBe("https://changed.example");
      expect(service.lockForPath("assets/hero.scene.hasset")).toBeUndefined();
      expect(service.isDocumentReadOnly("assets/hero.scene.hasset")).toBe(false);
      expect(service.bannerFor("assets/hero.scene.hasset")).toBeNull();
    } finally { service.dispose(); }
  });

  it.each(["conflicts", "is offline"] as const)("never blocks an edit when create %s", async (failure) => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    if (failure === "conflicts") fake.addTheirs("assets/a.hasset", "Bob");
    else vi.spyOn(fake, "create").mockRejectedValue(new TypeError("Failed to fetch"));
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.onEdit("assets/a.hasset");
    expect(service.isDocumentReadOnly("assets/a.hasset")).toBe(false);
    expect(service.bannerFor("assets/a.hasset")?.kind).toBe("unlocked");
  });

  it("keeps a Git LFS 409 already-ours lock as held", async () => {
    const lock = {
      id: "lock-1",
      path: "assets/a.hasset",
      locked_at: "2026-08-15T12:00:00Z",
      owner: { name: "Ada" },
    };
    const service = new SourceControlService();
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: false,
      hosts: await signedIn(async (request) => {
        if (request.method === "POST" && request.url.endsWith("/locks")) {
          return {
            status: 409,
            bodyText: JSON.stringify({
              lock,
              message: "already created lock",
            }),
          };
        }
        if (request.url.endsWith("/locks/verify")) {
          return {
            status: 200,
            bodyText: JSON.stringify({ ours: [lock], theirs: [] }),
          };
        }
        return { status: 500, bodyText: "{}" };
      }),
    });
    await service.onEdit("assets/a.hasset");
    expect(service.lockForPath("assets/a.hasset")?.ours).toBe(true);
    expect(service.bannerFor("assets/a.hasset")).toBeNull();
    service.dispose();
  });

  it("refuses moving someone else's lock and transfers ours", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.refresh();
    expect(service.refuseIfTheirs("assets/theirs.hasset")).toMatch(/Bob/);
    await service.onEdit("assets/mine.hasset");
    await service.transferLock(
      "assets/mine.hasset",
      "assets/renamed.hasset",
    );
    expect(service.lockForPath("assets/mine.hasset")).toBeUndefined();
    expect(service.lockForPath("assets/renamed.hasset")?.ours).toBe(true);
  });

  it("keeps held locks when only Lock On Edit changes", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const hosts = await signedIn();
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts,
      fake,
    });
    await service.onEdit("assets/a.hasset");
    await service.configure({
      settings: { ...manual, lockOnEdit: "never" },
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts,
      fake,
    });
    expect(service.lockForPath("assets/a.hasset")?.ours).toBe(true);
    expect(service.lockOnEdit).toBe("never");
  });

  it("skips create when verify already holds the path as ours", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    const first = new SourceControlService();
    await first.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await first.onEdit("assets/a.hasset");
    fake.createCount = 0;

    const second = new SourceControlService();
    await second.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await second.refresh();
    await second.onEdit("assets/a.hasset");
    expect(fake.createCount).toBe(0);
    expect(second.lockForPath("assets/a.hasset")?.ours).toBe(true);
    expect(second.bannerFor("assets/a.hasset")).toBeNull();
  });

  it("releases our lock for a deleted path and keeps theirs", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.onEdit("assets/mine.hasset");
    await service.refresh();
    await service.releasePath("assets/mine.hasset");
    await service.releasePath("assets/theirs.hasset");
    expect(service.lockForPath("assets/mine.hasset")).toBeUndefined();
    expect(service.lockForPath("assets/theirs.hasset")?.ours).toBe(false);
  });

  it("releases all of our locks", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.onEdit("assets/a.hasset");
    await service.onEdit("assets/b.hasset");
    expect(service.heldCount).toBe(2);
    await service.releaseAllMine();
    expect(service.heldCount).toBe(0);
    expect(fake.snapshot()).toHaveLength(0);
  });

  it("locks paths on request even with Lock On Edit Never, and names the holder of one someone else locked", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    await service.configure({
      settings: { ...manual, lockOnEdit: "never" },
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.lockPaths(["assets/a.hasset", "assets/theirs.hasset", "assets/b.hasset"]);
    expect(service.lockStateForPath("assets/a.hasset")).toBe("mine");
    expect(service.lockStateForPath("assets/b.hasset")).toBe("mine");
    expect(service.lockStateForPath("assets/theirs.hasset")).toBe("theirs");
    expect(service.operationError).toBe("assets/theirs.hasset: Locked by Bob");
    // A path already ours is not asked for again.
    const creates = fake.createCount;
    await service.lockPaths(["assets/a.hasset"]);
    expect(fake.createCount).toBe(creates);
    expect(service.operationError).toBeNull();
  });

  it("releases our locks on the paths asked for and leaves the rest", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.lockPaths(["assets/a.hasset", "assets/b.hasset", "assets/c.hasset"]);
    await service.refresh();
    await service.releasePaths(["assets/a.hasset", "assets/b.hasset", "assets/theirs.hasset"]);
    expect(service.lockStateForPath("assets/a.hasset")).toBeNull();
    expect(service.lockStateForPath("assets/b.hasset")).toBeNull();
    expect(service.lockStateForPath("assets/c.hasset")).toBe("mine");
    expect(service.lockStateForPath("assets/theirs.hasset")).toBe("theirs");
    expect(service.operationError).toBeNull();
  });

  it("keeps the lock list when the mode is turned Off and back on", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    await service.onEdit("assets/hero.scene.hasset");
    expect(service.lockForPath("assets/hero.scene.hasset")?.ours).toBe(true);

    await service.configure({
      settings: { ...manual, mode: "off" as const },
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    expect(service.enabled).toBe(false);
    expect(service.lockForPath("assets/hero.scene.hasset")?.ours).toBe(true);

    await service.configure({
      settings: manual,
      projectKey: "proj",
      platform: "electron",
      testMode: true,
      hosts: await signedIn(),
      fake,
    });
    expect(service.enabled).toBe(true);
    expect(service.lockForPath("assets/hero.scene.hasset")?.ours).toBe(true);
    expect(service.lockStateForPath("assets/hero.scene.hasset")).toBe("mine");
  });
});

describe("SourceControlService lock ref", () => {
  /** A Git LFS host that records each request's `ref.name` (by endpoint) and answers with no locks. */
  function recordingHost() {
    const refs: Array<[string, string]> = [];
    const http: HttpClient = async (request) => {
      // The sign-in check as the project opens is no lock request.
      if (request.url === "https://api.github.com/user") return { status: 200, bodyText: '{"login":"ada"}' };
      const body = JSON.parse(String(request.body ?? "{}")) as { path?: string; ref?: { name?: string } };
      const endpoint = request.url.endsWith("/verify") ? "verify" : request.url.endsWith("/unlock") ? "unlock" : "create";
      refs.push([endpoint, body.ref?.name ?? ""]);
      if (endpoint === "create") {
        return { status: 201, bodyText: JSON.stringify({ lock: { id: `${body.path}-lock`, path: body.path, locked_at: "", owner: { name: "ada" } } }) };
      }
      return { status: 200, bodyText: '{"ours":[],"theirs":[]}' };
    };
    return { refs, http };
  }

  it("sends the checked-out branch in Integrated mode for every lock request, and a push's own branch for its check", async () => {
    const { refs, http } = recordingHost();
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({
        settings: { ...manual, mode: "integrated", branch: "main" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http),
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      service.setCheckedOutBranch("feature");
      await service.refresh();
      await service.onEdit("assets/a.hasset");
      await service.releasePath("assets/a.hasset");
      await service.locksBlockingPush(["assets/a.hasset"], "hotfix");
      expect(refs).toEqual([
        ["verify", "refs/heads/feature"],
        // Once for the move: this device's own locks on the branch it left.
        ["verify", "refs/heads/main"],
        ["create", "refs/heads/feature"],
        ["unlock", "refs/heads/feature"],
        ["verify", "refs/heads/hotfix"],
      ]);

      // The branch not known (an open that failed or has not finished): checks list the team's default
      // branch, never an empty ref, while lock changes wait for the branch.
      refs.length = 0;
      service.setCheckedOutBranch("");
      await service.refresh();
      expect(refs).toEqual([["verify", "refs/heads/main"], ["verify", "refs/heads/feature"]]);
    } finally { service.dispose(); }
  });

  it("checks the locks again when the checked-out branch moves, and only then", async () => {
    const { refs, http } = recordingHost();
    const service = new SourceControlService();
    try {
      await service.configure({
        settings: { ...manual, mode: "integrated", branch: "main" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http),
      });
      await vi.waitFor(() => expect(refs).toEqual([["verify", "refs/heads/main"]]));
      service.setCheckedOutBranch("main");
      service.setCheckedOutBranch("feature");
      // The new branch, and once the branch left for this device's own locks there.
      await vi.waitFor(() => expect(refs).toEqual([["verify", "refs/heads/main"], ["verify", "refs/heads/feature"], ["verify", "refs/heads/main"]]));
      service.setCheckedOutBranch("feature");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(refs).toHaveLength(3);
    } finally { service.dispose(); }
  });

  it("holds lock changes in Integrated mode until the checked-out branch is known, and locks on it once it is", async () => {
    // Before the Git client opens, or after it could not: HEAD may be another branch than the default.
    const { refs, http } = recordingHost();
    const service = new SourceControlService();
    service.pausePolling();
    const changes = () => refs.filter(([endpoint]) => endpoint !== "verify");
    try {
      await service.configure({
        settings: { ...manual, mode: "integrated", branch: "main" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http),
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      await service.onEdit("assets/a.hasset");
      await expect(service.transferLock("assets/a.hasset", "assets/b.hasset")).resolves.toBeUndefined();
      expect(changes()).toEqual([]);

      // Edits made meanwhile lock once the branch is known.
      service.setCheckedOutBranch("feature");
      await vi.waitFor(() => expect(changes()).toEqual([["create", "refs/heads/feature"]]));
      expect(service.lockForPath("assets/a.hasset")?.ours).toBe(true);

      // A release while the branch is unknown says why it waits, and sends nothing.
      service.setCheckedOutBranch("");
      await service.releasePath("assets/a.hasset");
      expect(service.operationError).toMatch(/checked-out branch/);
      await expect(service.transferLock("assets/a.hasset", "assets/c.hasset")).rejects.toThrow(/checked-out branch/);
      expect(changes()).toEqual([["create", "refs/heads/feature"]]);

      // A folder Haptic does not run Git in (another Git app owns HEAD) locks on the default branch, as Manual mode does.
      service.setCheckedOutBranch(null);
      await service.onEdit("assets/d.hasset");
      expect(changes()).toEqual([["create", "refs/heads/feature"], ["create", "refs/heads/main"]]);
    } finally { service.dispose(); }
  });

  /** A Git LFS host that scopes locks by ref, recording each request's endpoint and ref. */
  function scopedHost() {
    const requests: Array<[string, string]> = [];
    const byRef = new Map<string, Map<string, string>>();
    let next = 1;
    const listed = (id: string, path: string) => ({ id, path, locked_at: "", owner: { name: "ada" } });
    const http: HttpClient = async (request) => {
      const body = JSON.parse(String(request.body ?? "{}")) as { path?: string; ref?: { name?: string } };
      const ref = body.ref?.name ?? "";
      const locks = byRef.get(ref) ?? new Map<string, string>();
      byRef.set(ref, locks);
      if (request.url.endsWith("/verify")) {
        requests.push(["verify", ref]);
        return { status: 200, bodyText: JSON.stringify({ ours: [...locks].map(([path, id]) => listed(id, path)), theirs: [] }) };
      }
      const unlock = /\/locks\/([^/]+)\/unlock$/.exec(request.url);
      if (unlock) {
        requests.push(["unlock", ref]);
        const id = decodeURIComponent(unlock[1]!);
        const path = [...locks].find(([, held]) => held === id)?.[0];
        if (path === undefined) return { status: 404, bodyText: '{"message":"Lock not found"}' };
        locks.delete(path);
        return { status: 200, bodyText: JSON.stringify({ lock: listed(id, path) }) };
      }
      requests.push(["create", ref]);
      const id = `lock-${next++}`;
      locks.set(body.path!, id);
      return { status: 201, bodyText: JSON.stringify({ lock: listed(id, body.path!) }) };
    };
    const held = (branch: string) => [...(byRef.get(`refs/heads/${branch}`) ?? new Map()).keys()].sort();
    return { requests, http, held };
  }

  it("keeps own locks on the branch it moved from listed and releasable, released after a push of their paths, checking that branch once", async () => {
    const host = scopedHost();
    const service = new SourceControlService();
    service.pausePolling();
    const HERO = "assets/hero.scene.hasset";
    const ROCK = "assets/rock.hasset";
    try {
      await service.configure({
        settings: { ...manual, mode: "integrated", branch: "main" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(host.http),
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      service.setCheckedOutBranch("main");
      await service.onEdit(HERO);
      await service.onEdit(ROCK);

      // A new branch is checked out: its own locks are listed, and those on main stay in view.
      service.setCheckedOutBranch("feature");
      await service.refresh();
      expect(service.locks.map((lock) => [lock.path, lock.ours, lock.branch])).toEqual([[HERO, true, "main"], [ROCK, true, "main"]]);
      expect(service.heldCount).toBe(2);
      // Main is checked once for the move, not on every check.
      await service.refresh();
      expect(host.requests.filter(([endpoint]) => endpoint === "verify")).toEqual([
        ["verify", "refs/heads/feature"],
        ["verify", "refs/heads/main"],
        ["verify", "refs/heads/feature"],
      ]);

      // Release Locks After Push: Hero was pushed from feature; its lock is on main.
      await service.releaseOwnLocks([HERO]);
      expect(host.held("main")).toEqual([ROCK]);
      // Release in the Locks window, on the lock's own branch.
      await service.release(service.locks.find((lock) => lock.path === ROCK)!.id);
      expect(host.held("main")).toEqual([]);
      expect(host.requests.filter(([endpoint]) => endpoint === "unlock")).toEqual([["unlock", "refs/heads/main"], ["unlock", "refs/heads/main"]]);
      expect([service.locks, service.heldCount, service.operationError]).toEqual([[], 0, null]);
    } finally { service.dispose(); }
  });

  it("holds an edit made before the branch is known even when the default branch lists it as locked, and locks it on the branch", async () => {
    const host = scopedHost();
    const service = new SourceControlService();
    service.pausePolling();
    const HERO = "assets/hero.scene.hasset";
    try {
      await service.configure({
        settings: { ...manual, mode: "integrated", branch: "main" },
        projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(host.http),
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      // An earlier session locked Hero on main; checks list main's locks while the branch is not known.
      service.setCheckedOutBranch("main");
      await service.onEdit(HERO);
      service.setCheckedOutBranch("");
      await service.refresh();
      expect(service.lockForPath(HERO)?.ours).toBe(true);

      await service.onEdit(HERO);
      service.setCheckedOutBranch("feature");
      await vi.waitFor(() => expect(host.held("feature")).toEqual([HERO]));
    } finally { service.dispose(); }
  });

  it("lists a lock once after a branch move on a host that does not scope locks by ref", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    service.pausePolling();
    try {
      await service.configure({ settings: { ...manual, mode: "integrated", branch: "main" }, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      service.setCheckedOutBranch("main");
      await service.onEdit("assets/a.hasset");
      service.setCheckedOutBranch("feature");
      await service.refresh();
      expect(service.locks.map((lock) => [lock.path, lock.branch])).toEqual([["assets/a.hasset", undefined]]);
      expect(service.heldCount).toBe(1);
    } finally { service.dispose(); }
  });

  it("keeps the default branch in Manual mode, where another Git app owns the working copy", async () => {
    const { refs, http } = recordingHost();
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: manual, projectKey: "proj", platform: "electron", testMode: false, hosts: await signedIn(http) });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      service.setCheckedOutBranch("feature");
      await service.refresh();
      await service.onEdit("assets/a.hasset");
      expect(refs).toEqual([["verify", "refs/heads/main"], ["create", "refs/heads/main"]]);
    } finally { service.dispose(); }
  });
});

describe("SourceControlService around an Integrated push", () => {
  const integrated = { ...manual, mode: "integrated" as const };

  it("names the locks someone else holds on what a push sends, from a fresh verify", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({ settings: integrated, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      // Taken after the last poll: only a fresh verify sees them.
      fake.addTheirs("assets/rock.hasset", "Sam");
      fake.addTheirs("assets/other.hasset", "Kim");
      const holders = await service.locksBlockingPush(["assets/rock.hasset", "assets/mine.hasset"], "main");
      expect(holders.map((lock) => [lock.path, lock.ownerName])).toEqual([["assets/rock.hasset", "Sam"]]);
    } finally {
      service.dispose();
    }
  });

  it("never blocks a push on a host without the locking API, and rejects when the check fails", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const other = "https://code.example.com";
    try {
      await service.configure({
        settings: { ...integrated, repositoryUrl: `${other}/team/game.git` },
        projectKey: "proj",
        platform: "electron",
        testMode: true,
        hosts: await signedIn(null, { ...GITHUB, origin: other, kind: "token" }),
        fake,
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      fake.addTheirs("assets/rock.hasset", "Sam");
      const verify = vi.spyOn(fake, "verify").mockResolvedValueOnce(err({ kind: "http", message: "Bad Gateway", status: 502 }));
      await expect(service.locksBlockingPush(["assets/rock.hasset"], "main")).rejects.toThrow("Bad Gateway");
      verify.mockResolvedValueOnce(err({ kind: "unsupported", message: "Not Found", status: 404 }));
      expect(await service.locksBlockingPush(["assets/rock.hasset"], "main")).toEqual([]);
      expect(service.lockingUnsupported).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it("releases own locks on pushed paths, keeping documents with unsaved edits locked", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    try {
      await service.configure({
        settings: integrated,
        projectKey: "proj",
        platform: "electron",
        testMode: true,
        hosts: await signedIn(),
        fake,
        isPathDirty: (path) => path === "assets/dirty.hasset",
      });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      // The sync's open names the checked-out branch.
      service.setCheckedOutBranch("main");
      for (const path of ["assets/pushed.hasset", "assets/dirty.hasset", "assets/unpushed.hasset"]) await service.onEdit(path);
      await service.releaseOwnLocks(["assets/pushed.hasset", "assets/dirty.hasset"]);
      expect(fake.snapshot().map((lock) => lock.path).sort()).toEqual(["assets/dirty.hasset", "assets/unpushed.hasset"]);
      expect(service.lockStateForPath("assets/pushed.hasset")).toBeNull();
    } finally {
      service.dispose();
    }
  });
});

describe("SourceControlService Lock On Edit", () => {
  const ask = { ...manual, lockOnEdit: "ask" as const };

  async function configured(settings: SourceControlProjectSettings = ask, fake = new FakeLockProvider({ selfName: "Ada" }), hosts?: SourceControlHosts) {
    const service = new SourceControlService();
    service.pausePolling();
    await service.configure({ settings, projectKey: "proj", platform: "electron", testMode: true, hosts: hosts ?? await signedIn(), fake });
    await service.refresh();
    return { service, fake };
  }

  it("asks about each edited file once, in one prompt for several, and locks nothing until Lock", async () => {
    const { service, fake } = await configured();
    const listener = vi.fn();
    service.subscribe(listener);
    try {
      await service.onEdit("assets/a.hasset");
      await service.onEdit("assets/b.hasset");
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual(["assets/a.hasset", "assets/b.hasset"]);
      expect(fake.createCount).toBe(0);
      expect(listener).toHaveBeenCalledTimes(2);
      // Same list, same array: a prompt re-rendering for another reason keeps it.
      expect(service.lockPrompt).toBe(service.lockPrompt);

      await service.answerLockPrompt(["assets/a.hasset", "assets/b.hasset"], true);
      expect(service.lockPrompt).toEqual([]);
      expect([service.lockStateForPath("assets/a.hasset"), service.lockStateForPath("assets/b.hasset")]).toEqual(["mine", "mine"]);
    } finally { service.dispose(); }
  });

  it("leaves a file unlocked after Don't Lock and asks again only once its file or lock changes", async () => {
    const { service, fake } = await configured();
    try {
      await service.onEdit("assets/a.hasset");
      await service.answerLockPrompt(["assets/a.hasset"], false);
      await service.onEdit("assets/a.hasset");
      expect([service.lockPrompt, fake.createCount, service.lockStateForPath("assets/a.hasset")]).toEqual([[], 0, null]);

      // A pull, branch switch, revert or another app changed the file.
      service.filesChanged(["assets/a.hasset", "assets/other.hasset"]);
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual(["assets/a.hasset"]);
    } finally { service.dispose(); }
  });

  it("answers only the files the prompt showed, keeping those edited since for the next prompt", async () => {
    const { service } = await configured();
    try {
      await service.onEdit("assets/a.hasset");
      const shown = service.lockPrompt;
      await service.onEdit("assets/b.hasset");
      await service.answerLockPrompt(shown, true);
      expect(service.lockStateForPath("assets/a.hasset")).toBe("mine");
      expect(service.lockStateForPath("assets/b.hasset")).toBeNull();
      expect(service.lockPrompt).toEqual(["assets/b.hasset"]);
    } finally { service.dispose(); }
  });

  it("asks again after the file's lock goes away: our release, or a list without someone else's lock", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    const { service } = await configured(ask, fake);
    try {
      await service.onEdit("assets/mine.hasset");
      await service.answerLockPrompt(["assets/mine.hasset"], true);
      await service.releasePath("assets/mine.hasset");
      await service.onEdit("assets/mine.hasset");
      expect(service.lockPrompt).toEqual(["assets/mine.hasset"]);

      // Don't Lock, then a teammate locks the file: nothing to ask while it holds, and again once a list drops it.
      await service.answerLockPrompt(["assets/mine.hasset"], false);
      const theirs = fake.addTheirs("assets/mine.hasset", "Bob");
      await service.refresh();
      await service.onEdit("assets/mine.hasset");
      expect(service.lockPrompt).toEqual([]);
      await fake.unlock(theirs.id, { force: true });
      await service.refresh();
      await service.onEdit("assets/mine.hasset");
      expect(service.lockPrompt).toEqual(["assets/mine.hasset"]);
    } finally { service.dispose(); }
  });

  it("drops a waiting file from the prompt once someone else locks it", async () => {
    const { service, fake } = await configured();
    try {
      await service.onEdit("assets/a.hasset");
      await service.onEdit("assets/b.hasset");
      fake.addTheirs("assets/a.hasset", "Bob");
      await service.refresh();
      expect(service.lockPrompt).toEqual(["assets/b.hasset"]);
    } finally { service.dispose(); }
  });

  it("shows no prompt while the host has no locking API or the saved sign-in was refused", async () => {
    const unsupported = new FakeLockProvider();
    vi.spyOn(unsupported, "verify").mockResolvedValue(err({ kind: "unsupported", message: "No locking", status: 404 }));
    const { service: noApi } = await configured(ask, unsupported);
    const accounts = await signedIn();
    const refused: SourceControlHosts = {
      credentialSource: (origin) => accounts.credentialSource(origin),
      http: null,
      subscribe: (listener) => accounts.subscribe(listener),
      signInState: () => "refused",
    };
    const { service: signIn } = await configured(ask, new FakeLockProvider(), refused);
    try {
      expect(noApi.lockingUnsupported).toBe(true);
      await noApi.onEdit("assets/a.hasset");
      expect(noApi.lockPrompt).toEqual([]);

      expect(signIn.signIn?.reason).toBe("refused");
      await signIn.onEdit("assets/a.hasset");
      expect(signIn.lockPrompt).toEqual([]);
    } finally {
      noApi.dispose();
      signIn.dispose();
    }
  });

  it("asks nothing without a sign-in, and asks about an edit made then once signed in", async () => {
    const service = new SourceControlService();
    service.pausePolling();
    const accounts = await signedIn(null, null);
    try {
      await service.configure({ settings: ask, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake: new FakeLockProvider() });
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual([]);
      await accounts.save(GITHUB);
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual(["assets/a.hasset"]);
    } finally { service.dispose(); }
  });

  it("holds an Integrated edit until the checked-out branch is known, then asks", async () => {
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: { ...ask, mode: "integrated" }, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake: new FakeLockProvider() });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual([]);
      service.setCheckedOutBranch("main");
      await vi.waitFor(() => expect(service.lockPrompt).toEqual(["assets/a.hasset"]));
    } finally { service.dispose(); }
  });

  it.each([
    ["always", ["mine"], []],
    ["never", [null], []],
  ] as const)("Lock On Edit %s asks nothing: the edited file's lock is %j", async (choice, states, prompt) => {
    const { service } = await configured({ ...manual, lockOnEdit: choice });
    try {
      await service.onEdit("assets/a.hasset");
      expect(service.lockPrompt).toEqual(prompt);
      expect([service.lockStateForPath("assets/a.hasset")]).toEqual(states);
    } finally { service.dispose(); }
  });

  it("drops the waiting prompt when Lock On Edit changes, and the next edit follows the new choice", async () => {
    const accounts = await signedIn();
    const fake = new FakeLockProvider();
    const { service } = await configured(ask, fake, accounts);
    try {
      await service.onEdit("assets/a.hasset");
      await service.configure({ settings: { ...manual, lockOnEdit: "always" }, projectKey: "proj", platform: "electron", testMode: true, hosts: accounts, fake });
      expect(service.lockPrompt).toEqual([]);
      await service.onEdit("assets/a.hasset");
      expect(service.lockStateForPath("assets/a.hasset")).toBe("mine");
    } finally { service.dispose(); }
  });

  it("names someone else's lock for saves only from a list of the branch lock requests name now", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: { ...manual, mode: "integrated", branch: "main" }, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedIn(), fake });
      await vi.waitFor(() => expect(service.enabled).toBe(true));
      service.setCheckedOutBranch("main");
      await service.refresh();
      await service.onEdit("assets/mine.hasset");
      expect(service.lockedByOther("assets/theirs.hasset")?.ownerName).toBe("Bob");
      expect(service.lockedByOther("assets/mine.hasset")).toBeNull();
      expect(service.lockedByOther("assets/free.hasset")).toBeNull();
      // Another branch is checked out and its list has not landed yet.
      service.setCheckedOutBranch("feature");
      expect(service.lockedByOther("assets/theirs.hasset")).toBeNull();
      await service.refresh();
      expect(service.lockedByOther("assets/theirs.hasset")?.ownerName).toBe("Bob");
    } finally { service.dispose(); }
  });
});
