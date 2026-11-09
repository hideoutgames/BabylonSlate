import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { loadDesktopShell, loadGameShellManifest, packageableDesktopTargets, parseGameShellManifest, type GameShellManifest, type GameShellSource } from "./game-shells";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const runtime = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
const host = new TextEncoder().encode("host();");

function manifest(overrides: Partial<GameShellManifest> = {}): GameShellManifest {
  return {
    electronVersion: "44.9.3",
    host: { file: "game-host.cjs", sha256: sha(host) },
    shells: [
      { target: "linux-x64", sha256: sha(runtime), size: runtime.length, source: "bundled", parts: ["electron-linux-x64.zip.000", "electron-linux-x64.zip.001"] },
      { target: "windows-x64", sha256: "a".repeat(64), size: 100, source: "desktop", files: ["electron.exe", "locales/en-US.pak"] },
    ],
    ...overrides,
  };
}

/** Files served under `/base/game-shells/`, as the deployed editor serves them. */
function source(files: Record<string, Uint8Array>, bridge: GameShellSource["bridge"] = null): GameShellSource & { requested: string[] } {
  const requested: string[] = [];
  return {
    base: "/base/",
    bridge,
    requested,
    fetch: async (url) => {
      requested.push(url);
      const name = url.replace("/base/game-shells/", "");
      return files[name] ? new Response(files[name] as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 });
    },
  };
}

describe("Game shells", () => {
  it("read the build's manifest, and none from a build without shells", async () => {
    const files = { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest())) };
    expect(await loadGameShellManifest(source(files))).toEqual(manifest());
    expect(await loadGameShellManifest(source({}))).toBeNull();
    expect(parseGameShellManifest({ ...manifest(), shells: [{ ...manifest().shells[0], parts: ["../escape"] }] })).toBeNull();
    expect(parseGameShellManifest({ ...manifest(), host: { file: "game-host.cjs", sha256: "short" } })).toBeNull();
    expect(parseGameShellManifest({ ...manifest(), shells: [{ ...manifest().shells[1], files: ["../../secret"] }] })).toBeNull();
  });

  it("offer bundled targets everywhere and the desktop app's own OS only where it runs", () => {
    expect([...packageableDesktopTargets(manifest(), null)]).toEqual(["linux-x64"]);
    const windowsApp = { platform: "win32", arch: "x64", runtime: vi.fn(), macIdentities: vi.fn(), packageMac: vi.fn() };
    expect([...packageableDesktopTargets(manifest(), windowsApp)].sort()).toEqual(["linux-x64", "windows-x64"]);
    expect([...packageableDesktopTargets(manifest(), { ...windowsApp, arch: "arm64" })]).toEqual(["linux-x64"]);
    expect([...packageableDesktopTargets(null, windowsApp)]).toEqual([]);
  });

  it("offer macOS only in the desktop app on a Mac, which signs it", () => {
    const withMac = manifest({ shells: [...manifest().shells, { target: "macos-arm64", sha256: "b".repeat(64), size: 10, source: "bundled", parts: ["electron-macos-arm64.zip.000"] }] });
    const mac = { platform: "darwin", arch: "x64", runtime: vi.fn(), macIdentities: vi.fn(), packageMac: vi.fn() };
    // An Intel Mac packages the Apple Silicon game too.
    expect([...packageableDesktopTargets(withMac, mac)].sort()).toEqual(["linux-x64", "macos-arm64"]);
    expect([...packageableDesktopTargets(withMac, null)]).toEqual(["linux-x64"]);
    // The Windows app on x64 offers its own runtime, never macOS.
    expect([...packageableDesktopTargets(withMac, { ...mac, platform: "win32" })].sort()).toEqual(["linux-x64", "windows-x64"]);
  });

  it("join a bundled runtime's parts and accept it only with the published SHA-256", async () => {
    const files = { "electron-linux-x64.zip.000": runtime.slice(0, 4), "electron-linux-x64.zip.001": runtime.slice(4), "game-host.cjs": host };
    const shell = await loadDesktopShell(manifest(), "linux-x64", source(files));
    expect([...shell.runtime]).toEqual([...runtime]);
    expect(new TextDecoder().decode(shell.host)).toBe("host();");

    const damaged = "The Linux player in this copy of Haptic is damaged. Reload or reinstall Haptic.";
    await expect(loadDesktopShell(manifest(), "linux-x64", source({ ...files, "electron-linux-x64.zip.001": new Uint8Array([9, 9, 9]) }))).rejects.toThrow(damaged);
    await expect(loadDesktopShell(manifest(), "linux-x64", source({ ...files, "electron-linux-x64.zip.001": new Uint8Array() }))).rejects.toThrow(damaged);
    await expect(loadDesktopShell(manifest(), "linux-x64", source({ ...files, "game-host.cjs": new TextEncoder().encode("evil();") }))).rejects.toThrow(damaged);
  });

  it("ask the desktop app for its own runtime with the release's file names and Electron version", async () => {
    const own = new Uint8Array([4, 4]);
    const bridge = { platform: "win32", arch: "x64", runtime: vi.fn(async () => own), macIdentities: vi.fn(), packageMac: vi.fn() };
    const shell = await loadDesktopShell(manifest(), "windows-x64", source({ "game-host.cjs": host }, bridge));
    expect(shell.runtime).toBe(own);
    expect(bridge.runtime).toHaveBeenCalledExactlyOnceWith(["electron.exe", "locales/en-US.pak"], "44.9.3");
    await expect(loadDesktopShell(manifest(), "windows-x64", source({ "game-host.cjs": host }))).rejects.toThrow("This copy of Haptic cannot package Windows games.");
  });
});
