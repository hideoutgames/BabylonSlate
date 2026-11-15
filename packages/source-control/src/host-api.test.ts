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
});
