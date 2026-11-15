import { describe, expect, it } from "vitest";
import {
  authorizedHttp,
  CredentialOriginError,
  CredentialStore,
  credentialUsername,
  fixedCredential,
  tokenCredential,
  type HostCredential,
} from "./credentials";
import { MemorySecrets } from "./fake-host";
import type { HttpRequest } from "./http";

const GITHUB: HostCredential = { origin: "https://github.com", username: "x-access-token", token: "gho_1", kind: "github", account: "ada" };

describe("credential usernames", () => {
  it("sends x-access-token for GitHub and other hosts, oauth2 for GitLab sign-in and a fixed name for GitLab tokens", () => {
    expect(credentialUsername("github")).toBe("x-access-token");
    expect(credentialUsername("token")).toBe("x-access-token");
    expect(credentialUsername("gitlab")).toBe("oauth2");
    const gitlabToken = credentialUsername("gitlab-token");
    expect(gitlabToken.trim()).not.toBe("");
    expect(tokenCredential("https://git.example.com", " glpat-1 ", "gitlab-token")).toEqual({
      origin: "https://git.example.com",
      username: gitlabToken,
      token: "glpat-1",
      kind: "gitlab-token",
    });
  });
});

describe("CredentialStore", () => {
  it("keeps one credential per origin, replacing on save and removing by origin", async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets);
    await store.save(GITHUB);
    await store.save(tokenCredential("https://gitea.example.com", "t1", "token"));
    await store.save({ ...GITHUB, token: "gho_2", account: "bea" });
    expect(await store.list()).toEqual([
      { origin: "https://gitea.example.com", username: "x-access-token", token: "t1", kind: "token" },
      { ...GITHUB, token: "gho_2", account: "bea" },
    ]);
    // Persisted: a new store on the same secrets reads the same credentials.
    expect((await new CredentialStore(secrets).get("https://github.com"))?.token).toBe("gho_2");
    await store.remove("https://github.com");
    expect(await new CredentialStore(secrets).get("https://github.com")).toBeNull();
    expect((await store.list()).map((entry) => entry.origin)).toEqual(["https://gitea.example.com"]);
  });

  it("does not drop a save made while another is in flight", async () => {
    const store = new CredentialStore(new MemorySecrets());
    await Promise.all([
      store.save(GITHUB),
      store.save(tokenCredential("https://a.example.com", "a", "token")),
      store.save(tokenCredential("https://b.example.com", "b", "token")),
    ]);
    expect((await store.list()).map((entry) => entry.origin).sort()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://github.com",
    ]);
  });

  it("never writes from a stale cache: another window's write in between survives", async () => {
    const secrets = new MemorySecrets();
    const first = new CredentialStore(secrets);
    const second = new CredentialStore(secrets);
    await first.save(GITHUB);
    expect(await first.list()).toHaveLength(1);
    // Another window adds a host and replaces the GitHub token; this window's cache knows neither.
    await second.save(tokenCredential("https://gitea.example.com", "t1", "token"));
    await second.save({ ...GITHUB, token: "gho_refreshed" });
    await first.save(tokenCredential("https://b.example.com", "b", "token"));
    await first.remove("https://gitea.example.com");
    const stored = await new CredentialStore(secrets).list();
    expect(stored.map((entry) => [entry.origin, entry.token])).toEqual([
      ["https://github.com", "gho_refreshed"],
      ["https://b.example.com", "b"],
    ]);
  });

  it("keeps a refresh token and expiry with the credential", async () => {
    const secrets = new MemorySecrets();
    const gitlab: HostCredential = { origin: "https://gitlab.com", username: "oauth2", token: "a", kind: "gitlab", refreshToken: "r", expiresAt: 1_000 };
    await new CredentialStore(secrets).save(gitlab);
    expect(await new CredentialStore(secrets).get("https://gitlab.com")).toEqual(gitlab);
  });

  it("refuses a non-HTTPS origin or an empty token, and ignores malformed stored entries", async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets);
    await expect(store.save({ ...GITHUB, origin: "http://github.com" })).rejects.toThrow();
    await expect(store.save({ ...GITHUB, origin: "https://github.com/org" })).rejects.toThrow();
    await expect(store.save({ ...GITHUB, token: "" })).rejects.toThrow();
    secrets.values.set("source-control:credentials", JSON.stringify([
      { origin: "http://plain.example.com", username: "u", token: "t", kind: "token" },
      { origin: "https://ok.example.com", username: "u", token: "t", kind: "token" },
      { origin: "https://bad-kind.example.com", username: "u", token: "t", kind: "password" },
      { origin: "https://no-token.example.com", username: "u", token: "", kind: "token" },
    ]));
    expect((await new CredentialStore(secrets).list()).map((entry) => entry.origin)).toEqual(["https://ok.example.com"]);
    secrets.values.set("source-control:credentials", "not json");
    expect(await new CredentialStore(secrets).list()).toEqual([]);
  });
});

describe("authorizedHttp", () => {
  function recorder() {
    const requests: HttpRequest[] = [];
    return {
      requests,
      http: async (request: HttpRequest) => {
        requests.push(request);
        return { status: 200, bodyText: "{}" };
      },
    };
  }

  it("adds Basic or Bearer authorization and refuses redirects", async () => {
    const { requests, http } = recorder();
    await authorizedHttp(fixedCredential(GITHUB), http, "basic")({ method: "GET", url: "https://github.com/org/repo.git/info/lfs/locks", headers: {} });
    await authorizedHttp(fixedCredential(GITHUB), http, "bearer")({ method: "GET", url: "https://api.github.com/user", headers: { Accept: "x" } });
    expect(requests.map((request) => [request.headers.Authorization, request.disableRedirects])).toEqual([
      [`Basic ${btoa("x-access-token:gho_1")}`, true],
      ["Bearer gho_1", true],
    ]);
  });

  it("never sends a token to another origin; only github.com also reaches api.github.com", async () => {
    const { requests, http } = recorder();
    const gitea = tokenCredential("https://gitea.example.com", "t", "token");
    for (const [credential, url] of [
      [GITHUB, "https://gist.github.com/"],
      [GITHUB, "https://github.com.evil.example/"],
      [GITHUB, "http://github.com/org/repo.git"],
      [GITHUB, "https://api.github.com.evil.example/user"],
      [gitea, "https://api.github.com/user"],
      [gitea, "https://gitea.example.com:8443/org/repo.git"],
      [tokenCredential("https://gitlab.example.com", "t", "gitlab-token"), "https://gitlab.com/api/v4/user"],
    ] as const) {
      await expect(authorizedHttp(fixedCredential(credential), http, "bearer")({ method: "GET", url, headers: {} })).rejects.toBeInstanceOf(CredentialOriginError);
    }
    expect(requests).toEqual([]);
  });
});
