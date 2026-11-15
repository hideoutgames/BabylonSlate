import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@haptic/core";
import { tokenCredential, type HostCredential } from "./credentials";
import { FakeGitHost } from "./fake-host";
import { hostApiFor } from "./host-api";
import type { HttpRequest } from "./http";

const GITHUB: HostCredential = { origin: "https://github.com", username: "x-access-token", token: "fake-gh", kind: "github" };
const GITLAB: HostCredential = { origin: "https://gitlab.com", username: "oauth2", token: "fake-gl", kind: "gitlab" };

describe("host APIs", () => {
  it("has no API for a plain token host", () => {
    expect(hostApiFor(tokenCredential("https://gitea.example.com", "t", "token"), new FakeGitHost().http)).toBeNull();
  });

  it("lists GitHub repositories and branches with clone URLs and default branches", async () => {
    const host = new FakeGitHost();
    const api = hostApiFor(GITHUB, host.http)!;
    const repositories = await api.repositories();
    expect(isOk(repositories) && repositories.value[0]).toEqual({
      name: "haptic-test/game",
      repositoryUrl: "https://github.com/haptic-test/game.git",
      defaultBranch: "main",
      private: true,
      updatedAt: "2026-11-01T10:00:00Z",
    });
    const branches = await api.branches("haptic-test/game");
    expect(isOk(branches) && branches.value).toEqual(["main", "develop"]);
    expect(host.requests.map((request) => request.url)).toEqual([
      "https://api.github.com/user/repos?per_page=100&sort=updated&page=1",
      "https://api.github.com/repos/haptic-test/game/branches?per_page=100&page=1",
    ]);
    expect(host.requests.every((request) => request.headers.Authorization === "Bearer fake-gh")).toBe(true);
  });

  it("reads the whole GitHub tree in one request and keeps only the wanted blobs", async () => {
    const host = new FakeGitHost();
    host.remoteBlobs.set("assets/a.hasset", "aaa");
    host.remoteBlobs.set("assets/b.hasset", "bbb");
    const result = await hostApiFor(GITHUB, host.http)!.blobIds("org/game", "feature/x", new Set(["assets/a.hasset", "assets/missing.hasset"]));
    expect(isOk(result) && [...result.value]).toEqual([["assets/a.hasset", "aaa"]]);
    expect(host.requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/org/game/git/trees/feature%2Fx?recursive=1",
    ]);
  });

  it("lists only the GitLab folders that hold wanted paths, each until its paths are found", async () => {
    const urls: string[] = [];
    const folders: Record<string, { path: string; type: string; id: string }[]> = {
      assets: Array.from({ length: 250 }, (_, index) => ({ path: `assets/${index}.hasset`, type: "blob", id: `id-${index}` })),
      "assets/Levels": [{ path: "assets/Levels/Forest.scene.hasset", type: "blob", id: "forest" }],
    };
    const http = async (request: HttpRequest) => {
      urls.push(request.url);
      const params = new URL(request.url).searchParams;
      expect(params.has("recursive")).toBe(false);
      const listing = folders[params.get("path") ?? ""];
      if (!listing) return { status: 404, bodyText: JSON.stringify({ message: "404 Tree Not Found" }) };
      const page = Number(params.get("page"));
      return { status: 200, bodyText: JSON.stringify(listing.slice((page - 1) * 100, page * 100)) };
    };
    const api = hostApiFor(GITLAB, http)!;
    const found = await api.blobIds("group/sub/game", "main", new Set([
      "assets/5.hasset",
      "assets/120.hasset",
      "assets/Levels/Forest.scene.hasset",
      "assets/Gone/Old.hasset",
    ]));
    expect(isOk(found) && Object.fromEntries(found.value)).toEqual({
      "assets/5.hasset": "id-5",
      "assets/120.hasset": "id-120",
      "assets/Levels/Forest.scene.hasset": "forest",
    });
    const project = "https://gitlab.com/api/v4/projects/group%2Fsub%2Fgame/repository/tree?ref=main";
    expect(urls).toEqual([
      // Stops at page 2 once both wanted `assets` paths are found.
      `${project}&path=assets&per_page=100&page=1`,
      `${project}&path=assets&per_page=100&page=2`,
      `${project}&path=assets%2FLevels&per_page=100&page=1`,
      // A folder missing from the branch holds nothing pushed.
      `${project}&path=assets%2FGone&per_page=100&page=1`,
    ]);
  });

  it("uses a self-managed GitLab instance's own API and maps failures", async () => {
    const urls: string[] = [];
    const api = hostApiFor(tokenCredential("https://git.example.com", "glpat", "gitlab-token"), async (request) => {
      urls.push(request.url);
      return { status: 401, bodyText: JSON.stringify({ message: "401 Unauthorized" }) };
    })!;
    const result = await api.repositories();
    expect(isErr(result) && result.error).toEqual({ kind: "unauthorized", message: "401 Unauthorized" });
    expect(urls[0]).toBe("https://git.example.com/api/v4/projects?membership=true&order_by=last_activity_at&per_page=100&page=1");
    const offline = await hostApiFor(GITLAB, async () => { throw new Error("down"); })!.branches("g/p");
    expect(isErr(offline) && offline.error.kind).toBe("offline");
  });

  it("lists the GitHub user first, then their organizations, and creates an empty repository under either", async () => {
    const host = new FakeGitHost();
    const api = hostApiFor(GITHUB, host.http)!;
    const owners = await api.owners();
    expect(isOk(owners) && owners.value).toEqual([
      { name: "test-user", kind: "user", id: "" },
      { name: "haptic-studio", kind: "organization", id: "" },
    ]);
    const mine = await api.createRepository({ owner: { name: "test-user", kind: "user", id: "" }, name: "forest-run", private: true });
    expect(isOk(mine) && mine.value).toMatchObject({ name: "test-user/forest-run", repositoryUrl: "https://github.com/test-user/forest-run.git", private: true });
    const team = await api.createRepository({ owner: { name: "haptic-studio", kind: "organization", id: "" }, name: "racer", private: false });
    expect(isOk(team) && team.value).toMatchObject({ name: "haptic-studio/racer", private: false });
    const posts = host.requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => [request.url, JSON.parse(request.body as string)])).toEqual([
      ["https://api.github.com/user/repos", { name: "forest-run", private: true, auto_init: false }],
      ["https://api.github.com/orgs/haptic-studio/repos", { name: "racer", private: false, auto_init: false }],
    ]);
    // A created repository is then listed, as the Clone picker reads it.
    const listed = await api.repositories();
    expect(isOk(listed) && listed.value.map((repository) => repository.name).slice(0, 2)).toEqual(["haptic-studio/racer", "test-user/forest-run"]);
  });

  describe("a Publish retried under the same name", () => {
    const owner = { name: "test-user", kind: "user", id: "" } as const;

    it.each([
      ["GitHub", GITHUB, "https://github.com/test-user/forest-run.git", [
        "POST https://api.github.com/user/repos",
        "GET https://api.github.com/repos/test-user/forest-run/branches?per_page=100&page=1",
        "GET https://api.github.com/repos/test-user/forest-run",
      ]],
      ["GitLab", GITLAB, "https://gitlab.com/test-user/forest-run.git", [
        "POST https://gitlab.com/api/v4/projects",
        "GET https://gitlab.com/api/v4/projects/test-user%2Fforest-run/repository/branches?per_page=100&page=1",
        "GET https://gitlab.com/api/v4/projects/test-user%2Fforest-run",
      ]],
    ] as const)("on %s takes the empty repository the interrupted attempt created", async (_host, credential, url, requests) => {
      const host = new FakeGitHost();
      const api = hostApiFor(credential, host.http)!;
      await api.createRepository({ owner, name: "forest-run", private: true });
      // The first attempt stopped before its push: the repository has no branch.
      host.requests.length = 0;
      const again = await api.createRepository({ owner, name: "forest-run", private: false });
      expect(isOk(again) && again.value).toMatchObject({ name: "test-user/forest-run", repositoryUrl: url, defaultBranch: "main", private: true });
      expect(host.requests.map((request) => `${request.method} ${request.url}`)).toEqual(requests);
      expect(host.repositories.filter((name) => name === "test-user/forest-run")).toHaveLength(1);
    });

    it.each([["GitHub", GITHUB], ["GitLab", GITLAB]] as const)("on %s refuses a repository that has branches, pushing nothing to it", async (_host, credential) => {
      const host = new FakeGitHost();
      const api = hostApiFor(credential, host.http)!;
      await api.createRepository({ owner, name: "forest-run", private: true });
      host.repositoryBranches.set("test-user/forest-run", ["main"]);
      const taken = await api.createRepository({ owner, name: "forest-run", private: true });
      expect(isErr(taken) && taken.error).toEqual({
        kind: "http",
        message: "test-user/forest-run already exists and is not empty. Choose another repository name.",
      });
    });

    it("keeps the host's reason when the name is refused for another reason, and asks nothing more after a refused token", async () => {
      const host = new FakeGitHost();
      const missing = await hostApiFor(GITHUB, async (request) => {
        host.requests.push(request);
        return request.method === "POST"
          ? { status: 422, bodyText: JSON.stringify({ message: "Repository creation failed.", errors: [{ message: "name is invalid" }] }) }
          : { status: 404, bodyText: JSON.stringify({ message: "Not Found" }) };
      })!.createRepository({ owner, name: "bad name", private: true });
      expect(isErr(missing) && missing.error).toEqual({ kind: "http", message: "Repository creation failed. name is invalid" });

      host.requests.length = 0;
      host.refusedTokens.add(GITHUB.token);
      const refused = await hostApiFor(GITHUB, host.http)!.createRepository({ owner, name: "forest-run", private: true });
      expect(isErr(refused) && refused.error.kind).toBe("unauthorized");
      expect(host.requests.map((request) => request.method)).toEqual(["POST"]);
    });
  });

  it("creates a GitLab project in the user's namespace or a group's, by namespace id", async () => {
    const host = new FakeGitHost();
    const api = hostApiFor(GITLAB, host.http)!;
    const owners = await api.owners();
    expect(isOk(owners) && owners.value).toEqual([
      { name: "test-user", kind: "user", id: "" },
      { name: "haptic-studio", kind: "organization", id: "100" },
    ]);
    await api.createRepository({ owner: { name: "test-user", kind: "user", id: "" }, name: "solo", private: true });
    const group = await api.createRepository({ owner: { name: "haptic-studio", kind: "organization", id: "100" }, name: "team", private: false });
    expect(isOk(group) && group.value).toMatchObject({ name: "haptic-studio/team", repositoryUrl: "https://gitlab.com/haptic-studio/team.git", private: false });
    const posts = host.requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => JSON.parse(request.body as string))).toEqual([
      { name: "solo", path: "solo", visibility: "private" },
      { name: "team", path: "team", visibility: "public", namespace_id: "100" },
    ]);
    expect(host.requests.find((request) => request.url.includes("/groups"))?.url).toBe("https://gitlab.com/api/v4/groups?min_access_level=30&per_page=100&page=1");
  });

  it("offers the signed-in user alone when the host refuses to list their organizations or groups", async () => {
    for (const credential of [GITHUB, GITLAB]) {
      const host = new FakeGitHost();
      host.organizationsRefused = true;
      const owners = await hostApiFor(credential, host.http)!.owners();
      expect(isOk(owners) && owners.value).toEqual([{ name: "test-user", kind: "user", id: "" }]);
      // The listing was asked for and refused, not skipped.
      expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual(
        credential === GITHUB ? ["/user", "/user/orgs"] : ["/api/v4/user", "/api/v4/groups"],
      );
    }
  });

  it("fails the owners when the signed-in user cannot be read", async () => {
    for (const credential of [GITHUB, GITLAB]) {
      const host = new FakeGitHost();
      host.refusedTokens.add(credential.token);
      const owners = await hostApiFor(credential, host.http)!.owners();
      expect(isErr(owners) && owners.error).toEqual({ kind: "unauthorized", message: "Bad credentials" });
    }
  });

  it("reads GitLab's field errors", async () => {
    const api = hostApiFor(GITLAB, async () => ({ status: 400, bodyText: JSON.stringify({ message: { path: ["has already been taken"] } }) }))!;
    const result = await api.createRepository({ owner: { name: "me", kind: "user", id: "" }, name: "taken", private: true });
    expect(isErr(result) && result.error).toEqual({ kind: "http", message: "path has already been taken" });
  });
});
