import { describe, expect, it } from "vitest";
import { lfsEndpointFromRepoUrl } from "./lfs-endpoint";

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
});
