import type { DesktopGameTarget } from "@haptic/exporter/native-desktop";
import { getElectronGameShellBridge, type ElectronGameShellBridge } from "@haptic/vfs";

/**
 * The players this editor build carries for native game packaging, described
 * by `game-shells/manifest.json` beside the editor (see
 * `apps/desktop/scripts/build-game-shells.mjs`). Bundled runtimes are
 * Electron's official release zips in parts; the desktop app supplies its own
 * runtime for its own OS.
 */
export interface GameShellEntry {
  target: DesktopGameTarget;
  /** SHA-256 of the release zip, as the pinned `electron` package records it. */
  sha256: string;
  size: number;
  source: "bundled" | "desktop";
  /** Bundled: the zip's parts, in order. */
  parts?: string[];
  /** Desktop: the release's file names, which the app reads from its own install folder. */
  files?: string[];
}

export interface GameShellManifest {
  electronVersion: string;
  host: { file: string; sha256: string };
  shells: GameShellEntry[];
}

const TARGETS: Record<DesktopGameTarget, { platform: string; arch: string; label: string }> = {
  "windows-x64": { platform: "win32", arch: "x64", label: "Windows" },
  "linux-x64": { platform: "linux", arch: "x64", label: "Linux" },
};
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isTarget = (value: unknown): value is DesktopGameTarget => typeof value === "string" && Object.hasOwn(TARGETS, value);
const isStrings = (value: unknown, valid: (entry: string) => boolean): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && valid(entry));

/** The manifest, or null when it is malformed. */
export function parseGameShellManifest(value: unknown): GameShellManifest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const host = raw.host as Record<string, unknown> | undefined;
  if (typeof raw.electronVersion !== "string" || !host || typeof host.file !== "string" || !FILE.test(host.file) ||
    typeof host.sha256 !== "string" || !SHA256.test(host.sha256) || !Array.isArray(raw.shells)) return null;
  const shells: GameShellEntry[] = [];
  for (const shell of raw.shells as Record<string, unknown>[]) {
    if (!shell || !isTarget(shell.target) || typeof shell.sha256 !== "string" || !SHA256.test(shell.sha256) ||
      typeof shell.size !== "number" || !Number.isSafeInteger(shell.size) || shell.size <= 0) return null;
    if (shell.source === "bundled" && isStrings(shell.parts, (part) => FILE.test(part))) {
      shells.push({ target: shell.target, sha256: shell.sha256, size: shell.size, source: "bundled", parts: shell.parts });
    } else if (shell.source === "desktop" && isStrings(shell.files, (file) => !file.split("/").some((part) => !part || part === ".." || part === "."))) {
      shells.push({ target: shell.target, sha256: shell.sha256, size: shell.size, source: "desktop", files: shell.files });
    } else {
      return null;
    }
  }
  return { electronVersion: raw.electronVersion, host: { file: host.file, sha256: host.sha256 }, shells };
}

export interface GameShellSource {
  fetch: (url: string) => Promise<Response>;
  /** The editor's base URL, which `game-shells/` sits under. */
  base: string;
  bridge: ElectronGameShellBridge | null;
}

const defaultSource = (): GameShellSource => ({ fetch: (url) => fetch(url), base: import.meta.env.BASE_URL ?? "/", bridge: getElectronGameShellBridge() });

/** This build's shell manifest; null when it carries none (development builds) or it cannot be read. */
export async function loadGameShellManifest(source: GameShellSource = defaultSource()): Promise<GameShellManifest | null> {
  try {
    const response = await source.fetch(`${source.base}game-shells/manifest.json`);
    return response.ok ? parseGameShellManifest(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Desktop targets this editor can package: bundled ones, and the desktop app's own OS when it runs there. */
export function packageableDesktopTargets(manifest: GameShellManifest | null, bridge = getElectronGameShellBridge()): Set<DesktopGameTarget> {
  const targets = new Set<DesktopGameTarget>();
  for (const shell of manifest?.shells ?? []) {
    const { platform, arch } = TARGETS[shell.target];
    if (shell.source === "bundled" || (bridge?.platform === platform && bridge.arch === arch)) targets.add(shell.target);
  }
  return targets;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(source: GameShellSource, file: string): Promise<Uint8Array> {
  const response = await source.fetch(`${source.base}game-shells/${file}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The target's Electron runtime and the game host, checked against the
 * manifest: a bundled runtime must have the SHA-256 Electron published, and
 * the host must match too.
 */
export async function loadDesktopShell(
  manifest: GameShellManifest,
  target: DesktopGameTarget,
  source: GameShellSource = defaultSource(),
): Promise<{ runtime: Uint8Array; host: Uint8Array }> {
  const label = TARGETS[target].label;
  const damaged = () => new Error(`The ${label} player in this copy of Haptic is damaged. Reload or reinstall Haptic.`);
  const shell = manifest.shells.find((entry) => entry.target === target);
  if (!shell) throw new Error(`This copy of Haptic cannot package ${label} games.`);
  let runtime: Uint8Array;
  if (shell.source === "bundled") {
    runtime = new Uint8Array(shell.size);
    let offset = 0;
    for (const part of shell.parts!) {
      const bytes = await fetchBytes(source, part).catch(() => { throw damaged(); });
      if (offset + bytes.length > runtime.length) throw damaged();
      runtime.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== shell.size || (await sha256(runtime)) !== shell.sha256) throw damaged();
  } else {
    if (!source.bridge) throw new Error(`This copy of Haptic cannot package ${label} games.`);
    runtime = await source.bridge.runtime(shell.files!, manifest.electronVersion);
  }
  const host = await fetchBytes(source, manifest.host.file).catch(() => { throw damaged(); });
  if ((await sha256(host)) !== manifest.host.sha256) throw damaged();
  return { runtime, host };
}
