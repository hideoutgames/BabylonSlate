import { describe, expect, it } from "vitest";
import { canPublishProject, integratedBlocker, offeredSourceControlModes, sameRepository, type SourceControlFolder } from "./source-control-mode";

const folder = (platform: string, tier: SourceControlFolder["tier"], hasGit: boolean, testMode = false): SourceControlFolder =>
  ({ platform, tier, hasGit, testMode });

describe("Integrated mode rules (one Git client per folder)", () => {
  it.each([
    ["production web", folder("web", "opfs", true), "unavailable"],
    ["test mode, no .git", folder("web", "opfs", false, true), null],
    ["iPad app storage with .git", folder("ios", "documents", true), null],
    ["iPad app storage without .git", folder("ios", "documents", false), "no-repository"],
    ["iPad folder another app syncs", folder("ios", "external", true), "other-git-client"],
    ["Android chosen folder", folder("android", "external", true), "other-git-client"],
    ["desktop chosen folder with .git", folder("electron", "external", true), null],
    ["desktop Projects folder without .git", folder("electron", "documents", false), "no-repository"],
  ] as const)("runs the Git client in %s: %s", (_name, where, blocker) => {
    expect(integratedBlocker(where)).toBe(blocker);
  });

  it.each([
    ["Off on an iPad, even with .git", "off", folder("ios", "external", true), ["off", "manual"]],
    ["Manual on Android", "manual", folder("android", "documents", true), ["off", "manual"]],
    ["an Integrated project anywhere", "integrated", folder("ios", "documents", true), ["off", "integrated", "manual"]],
    ["Manual on desktop with .git", "manual", folder("electron", "external", true), ["off", "integrated", "manual"]],
    ["Off on desktop without .git", "off", folder("electron", "documents", false), ["off", "manual"]],
  ] as const)("offers modes for %s", (_name, stored, where, modes) => {
    expect(offeredSourceControlModes(stored, where)).toEqual(modes);
  });

  it.each([
    ["an Off project in iPad app storage", "off", folder("ios", "documents", false), true],
    ["an Off project in a chosen iPad folder", "off", folder("ios", "external", false), false],
    ["an Off project in a chosen desktop folder", "off", folder("electron", "external", false), true],
    ["a folder that already has .git", "off", folder("electron", "documents", true), false],
    ["a Manual project", "manual", folder("ios", "documents", false), false],
    ["production web", "off", folder("web", "opfs", false), false],
    ["test mode", "off", folder("web", "opfs", false, true), true],
  ] as const)("publishes %s: %s", (_name, stored, where, allowed) => {
    expect(canPublishProject(stored, where)).toBe(allowed);
  });
});

describe("sameRepository", () => {
  it("compares the HTTPS repository behind HTTPS, SSH and scp-style URLs", () => {
    expect(sameRepository("git@github.com:team/game.git", "https://github.com/team/game")).toBe(true);
    expect(sameRepository("https://github.com/team/game.git", "https://github.com/team/other.git")).toBe(false);
  });
});
