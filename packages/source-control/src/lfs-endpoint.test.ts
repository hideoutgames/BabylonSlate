import { describe, expect, it } from "vitest";
import { hostOrigin, lfsEndpointFromRepoUrl, parseRepositoryUrl } from "./lfs-endpoint";

describe("lfsEndpointFromRepoUrl", () => {
  it("derives GitHub HTTPS URLs with and without .git", () => {
    expect(lfsEndpointFromRepoUrl("https://github.com/org/repo")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("https://github.com/org/repo.git/")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
  });

  it("derives GitHub SSH remotes to the HTTPS LFS host", () => {
    expect(lfsEndpointFromRepoUrl("git@github.com:org/repo.git")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("ssh://git@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("ssh://git@github.com/org/repo")).toBe(
      "https://github.com/org/repo.git/info/lfs",
    );
  });

  it("drops the SSH port and user from the HTTPS LFS host", () => {
    expect(lfsEndpointFromRepoUrl("ssh://git@gitlab.example.com:2222/group/repo.git")).toBe(
      "https://gitlab.example.com/group/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("ssh://alice@host.example.com/org/repo")).toBe(
      "https://host.example.com/org/repo.git/info/lfs",
    );
  });

  it("derives GitLab and Gitea HTTPS and SSH remotes", () => {
    expect(lfsEndpointFromRepoUrl("https://gitlab.com/group/sub/repo.git")).toBe(
      "https://gitlab.com/group/sub/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("git@gitlab.com:group/repo.git")).toBe(
      "https://gitlab.com/group/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("https://gitea.example.com/org/repo")).toBe(
      "https://gitea.example.com/org/repo.git/info/lfs",
    );
    expect(lfsEndpointFromRepoUrl("git@gitea.example.com:org/repo.git")).toBe(
      "https://gitea.example.com/org/repo.git/info/lfs",
    );
  });

  it("returns null for empty or unparseable remotes", () => {
    expect(lfsEndpointFromRepoUrl("")).toBeNull();
    expect(lfsEndpointFromRepoUrl("   ")).toBeNull();
    expect(lfsEndpointFromRepoUrl("not-a-url")).toBeNull();
  });

  it("upgrades a plain HTTP remote so a token never travels over plain HTTP", () => {
    expect(lfsEndpointFromRepoUrl("http://gitea.example.com:3000/org/repo")).toBe(
      "https://gitea.example.com:3000/org/repo.git/info/lfs",
    );
  });
});

describe("parseRepositoryUrl", () => {
  it("names the HTTPS origin a credential is looked up by and the repository path", () => {
    expect(parseRepositoryUrl("git@github.com:org/repo.git")).toEqual({ origin: "https://github.com", path: "org/repo" });
    expect(parseRepositoryUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toEqual({
      origin: "https://gitlab.example.com",
      path: "group/sub/repo",
    });
    expect(parseRepositoryUrl("https://Gitea.Example.com:8443/org/repo/")).toEqual({
      origin: "https://gitea.example.com:8443",
      path: "org/repo",
    });
    expect(parseRepositoryUrl("ftp://example.com/org/repo")).toBeNull();
    expect(parseRepositoryUrl("https://github.com/")).toBeNull();
  });
});

describe("hostOrigin", () => {
  it("names the HTTPS origin of a typed host, upgrading plain HTTP", () => {
    expect(hostOrigin("gitea.example.com")).toBe("https://gitea.example.com");
    expect(hostOrigin("http://git.example.com:3000/team/game.git")).toBe("https://git.example.com:3000");
    expect(hostOrigin("ssh://git.example.com")).toBeNull();
    expect(hostOrigin("   ")).toBeNull();
  });
});
