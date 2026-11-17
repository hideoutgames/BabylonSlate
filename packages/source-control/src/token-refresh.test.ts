import { describe, expect, it, vi } from "vitest";
import { isOk } from "@haptic/core";
import { CredentialStore, type HostCredential } from "./credentials";
import { completeDeviceSignIn, requestDeviceCode, type DeviceClock } from "./device-flow";
import { FakeGitHost, MemorySecrets } from "./fake-host";
import { hostApiFor } from "./host-api";
import type { HttpClient } from "./http";
import { REFRESH_MARGIN_MS, RefreshingCredentials } from "./token-refresh";

const HOUR = 3_600_000;

function clock(start = 1_000_000) {
  let now = start;
  const device: DeviceClock = { now: () => now, wait: async (ms) => { now += ms; } };
  return { device, now: () => now, set: (value: number) => { now = value; } };
}

/** A GitLab sign-in through the fake host, saved in a fresh store. */
async function signedInToGitLab(host: FakeGitHost, time: ReturnType<typeof clock>, secrets = new MemorySecrets()) {
  host.tokenReplies = [];
  const code = await requestDeviceCode("gitlab", "client", host.http, time.device);
  if (!isOk(code)) throw new Error("no code");
  const signedIn = await completeDeviceSignIn(code.value, "client", host.http, time.device);
  if (!isOk(signedIn)) throw new Error("no sign-in");
  const store = new CredentialStore(secrets);
  await store.save(signedIn.value);
  return { store, secrets, credential: signedIn.value };
}

function refreshing(store: CredentialStore, http: HttpClient, time: ReturnType<typeof clock>, onChange = vi.fn()) {
  return { credentials: new RefreshingCredentials({ store, http, now: time.now, clientId: () => "client", onChange }), onChange };
}

const refreshes = (host: FakeGitHost) =>
  host.requests.filter((request) => new URLSearchParams((request.body as string | undefined) ?? "").get("grant_type") === "refresh_token");

describe("GitLab sign-in refresh", () => {
  it("saves the refresh token and expiry a GitLab sign-in returns; a GitHub sign-in keeps only an expiry it is given", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const { credential } = await signedInToGitLab(host, time);
    expect(credential).toMatchObject({ kind: "gitlab", token: "fake-gitlab-token", refreshToken: "fake-gitlab-refresh-1" });
    expect(credential.expiresAt).toBe(time.now() + 2 * HOUR);
    const signInToGitHub = async () => {
      host.tokenReplies = [];
      const code = await requestDeviceCode("github", "client", host.http, time.device);
      if (!isOk(code)) throw new Error("no code");
      const github = await completeDeviceSignIn(code.value, "client", host.http, time.device);
      if (!isOk(github)) throw new Error("no sign-in");
      return github.value;
    };
    // An OAuth App's token does not expire.
    expect([(await signInToGitHub()).refreshToken, (await signInToGitHub()).expiresAt]).toEqual([undefined, undefined]);
    // A GitHub App's user token may: its expiry is kept, so the device can tell it lapsed. GitHub tokens are never
    // refreshed, so no refresh token is kept.
    host.githubExpiresIn = 8 * 3600;
    const expiring = await signInToGitHub();
    expect([expiring.refreshToken, expiring.expiresAt]).toEqual([undefined, time.now() + 8 * HOUR]);
  });

  it("reports a refused credential it has no replacement for", async () => {
    const host = new FakeGitHost();
    const store = new CredentialStore(new MemorySecrets());
    const github: HostCredential = { origin: "https://github.com", username: "x-access-token", token: "fake-github-token", kind: "github" };
    await store.save(github);
    host.refusedTokens.add(github.token);
    const onRefused = vi.fn();
    const credentials = new RefreshingCredentials({ store, http: host.http, now: () => 0, clientId: () => "client", onRefused });
    const api = hostApiFor(github, host.http, credentials.source(github.origin))!;
    expect(await api.user()).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    expect(onRefused).toHaveBeenCalledWith(github.origin, github);
  });

  it("refreshes shortly before expiry, once for requests made together, and keeps the new token", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const { store, secrets, credential } = await signedInToGitLab(host, time);
    const { credentials, onChange } = refreshing(store, host.http, time);
    const source = credentials.source("https://gitlab.com");
    time.set(credential.expiresAt! - REFRESH_MARGIN_MS - 1);
    expect((await source.current())?.token).toBe("fake-gitlab-token");
    expect(refreshes(host)).toHaveLength(0);
    time.set(credential.expiresAt! - REFRESH_MARGIN_MS);
    const [a, b, c] = await Promise.all([source.current(), source.current(), source.current()]);
    expect([a?.token, b?.token, c?.token]).toEqual(["fake-gitlab-token-2", "fake-gitlab-token-2", "fake-gitlab-token-2"]);
    expect(refreshes(host).map((request) => Object.fromEntries(new URLSearchParams(request.body as string)))).toEqual([
      { grant_type: "refresh_token", refresh_token: "fake-gitlab-refresh-1", client_id: "client" },
    ]);
    expect(refreshes(host)[0]?.url).toBe("https://gitlab.com/oauth/token");
    // Read back as another window would, through the stored text: the account and its id (the commit author) survive.
    expect(await new CredentialStore(secrets).get("https://gitlab.com")).toMatchObject({
      token: "fake-gitlab-token-2",
      refreshToken: "fake-gitlab-refresh-2",
      expiresAt: time.now() + 2 * HOUR,
      account: "test-user",
      accountId: "1001",
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("renews once after a 401 and retries the request with the new token", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const { store, credential } = await signedInToGitLab(host, time);
    const { credentials } = refreshing(store, host.http, time);
    host.refusedTokens.add("fake-gitlab-token");
    host.requests.length = 0;
    const api = hostApiFor(credential, host.http, credentials.source("https://gitlab.com"))!;
    const listed = await api.repositories();
    expect(isOk(listed)).toBe(true);
    expect(host.requests.map((request) => [request.method, new URL(request.url).pathname, request.headers.Authorization ?? ""])).toEqual([
      ["GET", "/api/v4/projects", "Bearer fake-gitlab-token"],
      ["POST", "/oauth/token", ""],
      ["GET", "/api/v4/projects", "Bearer fake-gitlab-token-2"],
    ]);
  });

  it("signs the host out when the refresh is rejected or the build has no client id", async () => {
    for (const reject of ["spent refresh token", "no client id"] as const) {
      const host = new FakeGitHost();
      const time = clock();
      const { store, credential } = await signedInToGitLab(host, time);
      if (reject === "spent refresh token") {
        await store.save({ ...credential, refreshToken: "fake-gitlab-refresh-spent" });
      }
      const onChange = vi.fn();
      const credentials = new RefreshingCredentials({
        store, http: host.http, now: time.now, onChange,
        clientId: () => (reject === "no client id" ? null : "client"),
      });
      time.set(credential.expiresAt!);
      expect(await credentials.source("https://gitlab.com").current()).toBeNull();
      expect(await store.reload("https://gitlab.com")).toBeNull();
      expect(onChange).toHaveBeenCalledOnce();
    }
  });

  it("keeps the credential and fails the request when the host cannot be reached", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const { store, credential } = await signedInToGitLab(host, time);
    const offline: HttpClient = async () => { throw new Error("The Internet connection appears to be offline."); };
    const { credentials, onChange } = refreshing(store, offline, time);
    time.set(credential.expiresAt!);
    await expect(credentials.source("https://gitlab.com").current()).rejects.toThrow(/Could not refresh the gitlab.com sign-in/);
    expect((await store.reload("https://gitlab.com"))?.token).toBe("fake-gitlab-token");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses another window's refresh instead of spending the refresh token again", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const { store, secrets, credential } = await signedInToGitLab(host, time);
    const otherWindow = new CredentialStore(secrets);
    expect((await otherWindow.get("https://gitlab.com"))?.token).toBe("fake-gitlab-token");
    time.set(credential.expiresAt!);
    expect((await refreshing(store, host.http, time).credentials.source("https://gitlab.com").current())?.token).toBe("fake-gitlab-token-2");
    // The other window's cache still holds the spent token; it takes the stored one.
    const other = refreshing(otherWindow, host.http, time).credentials.source("https://gitlab.com");
    expect((await other.current())?.token).toBe("fake-gitlab-token-2");
    expect(refreshes(host)).toHaveLength(1);
  });

  it("never renews a credential that does not expire", async () => {
    const host = new FakeGitHost();
    const time = clock();
    const store = new CredentialStore(new MemorySecrets());
    const github: HostCredential = { origin: "https://github.com", username: "x-access-token", token: "fake-gh", kind: "github" };
    await store.save(github);
    const { credentials, onChange } = refreshing(store, host.http, time);
    time.set(time.now() + 1_000 * HOUR);
    expect(await credentials.source("https://github.com").current()).toEqual(github);
    expect(await credentials.source("https://github.com").renew(github)).toBeNull();
    expect(await store.get("https://github.com")).toEqual(github);
    expect(onChange).not.toHaveBeenCalled();
    expect(host.requests).toEqual([]);
  });
});
