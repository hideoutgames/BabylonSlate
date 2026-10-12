import { describe, expect, it } from "vitest";
import { parseGitConfigPrefill } from "./git-config";

describe("parseGitConfigPrefill", () => {
  it("reads origin url and the current HEAD branch", () => {
    const config = `
[core]
	repositoryformatversion = 0
[remote "origin"]
	url = git@github.com:hideoutgames/BabylonSlate.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
`;
    expect(parseGitConfigPrefill(config, "ref: refs/heads/main\n")).toEqual({
      repositoryUrl: "git@github.com:hideoutgames/BabylonSlate.git",
      branch: "main",
    });
  });

  it("falls back to the first branch merge ref when HEAD is missing", () => {
    const config = `
[remote "origin"]
	url = https://github.com/org/repo.git
[branch "develop"]
	merge = refs/heads/develop
`;
    expect(parseGitConfigPrefill(config, null)).toEqual({
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "develop",
    });
  });

  it("leaves the branch empty for a detached HEAD", () => {
    const config = `
[remote "origin"]
	url = https://github.com/org/repo.git
[branch "develop"]
	merge = refs/heads/develop
`;
    expect(parseGitConfigPrefill(config, "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n").branch).toBe("");
  });

  it("unquotes values and drops trailing comments", () => {
    const config = `
[remote "origin"]
	url = "https://git.example.com/org/repo;v2.git" # mirror
[branch "main"]
	merge = refs/heads/main ; tracked
`;
    expect(parseGitConfigPrefill(config, null)).toEqual({
      repositoryUrl: "https://git.example.com/org/repo;v2.git",
      branch: "main",
    });
  });

  it("returns empty fields when .git/config has no origin", () => {
    expect(parseGitConfigPrefill("[core]\n\trepositoryformatversion = 0\n", null)).toEqual({
      repositoryUrl: "",
      branch: "",
    });
  });
});
