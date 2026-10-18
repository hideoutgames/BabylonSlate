import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isLibraryFolder } from "@babylonslate/vfs/library-folders";

/** Largest payload one project IPC call may move through the main process. */
export const MAX_IPC_BYTES = 512 * 1024 * 1024;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid desktop request");
}

export function rendererFile(rawUrl: string, root: string): string {
  // Check before WHATWG URL normalization can erase dot segments.
  const decoded = decodeURIComponent(rawUrl);
  requireValue(!/[\\%]/.test(decoded) && !decoded.includes("\0"));
  requireValue(!decoded.split(/[/?#]/).some(part => part === ".." || part === "."));
  const url = new URL(rawUrl);
  requireValue(url.protocol === "app:" && url.host === "babylonslate" && !url.username && !url.password);
  const pathname = decodeURIComponent(url.pathname);
  requireValue(!pathname.includes(":"));
  // Win32 drops trailing dots and spaces from each segment, so `.. ` would
  // reach the filesystem as a parent reference. No bundled name ends that way.
  requireValue(!pathname.split("/").some(part => /[. ]$/.test(part)));
  const file = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
  const within = relative(resolve(root), file);
  requireValue(within !== ".." && !within.startsWith("..") && !isAbsolute(within));
  return file;
}

function bundledUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "app:" && url.host === "babylonslate" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function isEditorSender(rawUrl: string, mainFrame: boolean): boolean {
  const url = bundledUrl(rawUrl);
  return mainFrame && url !== null && ["/", "/index.html"].includes(url.pathname);
}

/** A subframe may only host the bundled Preview player. */
export function isPreviewFrameUrl(rawUrl: string): boolean {
  const url = bundledUrl(rawUrl);
  return url !== null && ["/player/", "/player/index.html"].includes(url.pathname);
}

/** RevenueCat Web Billing checkout and its Stripe payment frames. */
const BILLING_FRAME_HOSTS = [/(^|\.)stripe\.com$/, /(^|\.)stripe\.network$/, /(^|\.)revenuecat\.com$/, /^pay\.rev\.cat$/];

/** A subframe may host Web Billing checkout over HTTPS. */
export function isBillingFrameUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && BILLING_FRAME_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

/** Haptic's site, for pricing and plan details. */
const HAPTIC_SITE_HOST = /(^|\.)haptic\.no$/;

/**
 * Links the editor hands to the system browser or mail client: Haptic's site
 * and Web Billing pages over HTTPS, and mailto. Anything else stays denied, so
 * project scripts in the Preview frame cannot open arbitrary sites.
 */
export function externalOpenUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "mailto:") return url.href;
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return HAPTIC_SITE_HOST.test(url.hostname) || isBillingFrameUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

/** The editor frame may write the clipboard; every other permission is denied. */
export function allowsEditorPermission(permission: string, requestingUrl: string, mainFrame: boolean): boolean {
  return permission === "clipboard-sanitized-write" && isEditorSender(requestingUrl, mainFrame);
}

/**
 * Canonical folder a project id may reopen without the picker: a folder directly
 * inside the canonical `projectsHome`, or one granted through the folder picker.
 * The desktop host only issues `node:` ids, so any other id is refused. Both
 * checks use the canonical path that is then opened, so a link cannot stand in
 * for a project.
 */
export async function knownProjectFolder(
  id: string,
  projectsHome: string,
  grants: () => Promise<readonly string[]>,
): Promise<string> {
  if (id.startsWith("node:")) {
    const target = await realpath(id.slice("node:".length));
    if (dirname(target) === projectsHome || (await grants()).includes(target)) return target;
  }
  throw new Error("Choose this folder using the folder picker first");
}

function text(value: unknown, max = 1024 * 1024): asserts value is string {
  requireValue(typeof value === "string" && value.length <= max && !value.includes("\0"));
}

function projectPath(value: unknown, allowRoot = true): void {
  text(value, 4096);
  requireValue(!/[\\:]/.test(value) && !value.startsWith("/") && !value.split("/").includes(".."));
  if (!allowRoot) requireValue(value !== "" && value !== ".");
}

/**
 * File operations a user library scope may perform. `library:*` mirrors these
 * `project:*` channels with the scope as an extra first argument; the
 * project-only channels (picker, Documents, reopen, list, release) have no
 * library counterpart, so a library can never be pointed at another folder.
 */
export const LIBRARY_FILE_OPERATIONS = [
  "readBinary", "readBinaryRange", "writeBinary", "exists", "readdir", "mkdir", "remove", "stat",
] as const;

export function validateIpcArguments(channel: string, args: unknown[]): void {
  const operation = channel.startsWith("library:") ? channel.slice("library:".length) : null;
  if (operation !== null) {
    requireValue((LIBRARY_FILE_OPERATIONS as readonly string[]).includes(operation));
    // Exactly the shared allowlist: no other folder name, path or object.
    requireValue(isLibraryFolder(args[0]));
    validateIpcArguments(`project:${operation}`, args.slice(1));
    return;
  }
  const counts: Record<string, number> = {
    "save-games:read": 1, "save-games:write": 2, "save-games:remove": 1,
    "save-games:list": 1, "save-games:acquire-lock": 1, "save-games:release-lock": 1,
    "settings:read": 0, "settings:write": 1, "secrets:get": 1, "secrets:set": 2, "secrets:delete": 1,
    "account-secrets:get": 1, "account-secrets:set": 2, "account-secrets:delete": 1,
    "lfs:fetch": 1, "project:pickFolder": 0, "project:openDocuments": 1, "project:openKnown": 1,
    "project:list": 0, "project:release": 0, "project:readBinary": 1, "project:readBinaryRange": 4,
    "project:writeBinary": 2, "project:exists": 1, "project:readdir": 1, "project:mkdir": 2,
    "project:remove": 1, "project:stat": 1,
  };
  requireValue(Object.hasOwn(counts, channel) && args.length === counts[channel]);
  if (channel.startsWith("save-games:")) {
    text(args[0], 4096);
    if (channel === "save-games:release-lock") requireValue(/^[a-zA-Z0-9-]{1,100}$/.test(args[0]));
    else {
      const path = channel === "save-games:list" ? args[0].replace(/\/$/, "") : args[0];
      requireValue(!/[\\:]/.test(path) && !path.startsWith("/") &&
        path.split("/").every(part => part.length > 0 && part !== "." && part !== ".."));
    }
    if (channel === "save-games:write") text(args[1], 32 * 1024 * 1024);
  } else if (channel === "settings:write") {
    text(args[0]);
    const parsed: unknown = JSON.parse(args[0]);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } else if (channel.startsWith("secrets:") || channel.startsWith("account-secrets:")) {
    text(args[0], 1024);
    requireValue(args[0].length > 0);
    if (channel.endsWith(":set")) text(args[1]);
  } else if (channel === "project:openDocuments") {
    text(args[0], 200);
    requireValue(args[0].length > 0 && !/[\\/:<>"|?*]/.test(args[0]) && ![".", ".."].includes(args[0]) && !/[. ]$/.test(args[0]));
  } else if (channel === "project:openKnown") {
    requireValue(args[0] && typeof args[0] === "object");
    const handle = args[0] as Record<string, unknown>;
    text(handle.id, 4096);
    text(handle.name, 200);
    validateIpcArguments("project:openDocuments", [handle.name]);
    requireValue(handle.tier === "documents" || handle.tier === "external");
  } else if (channel === "lfs:fetch") {
    requireValue(args[0] && typeof args[0] === "object");
    const request = args[0] as Record<string, unknown>;
    text(request.url, 8192);
    const url = new URL(request.url);
    requireValue(url.protocol === "https:" && !url.username && !url.password);
    requireValue(request.method === undefined || ["GET", "POST", "PUT", "DELETE", "HEAD"].includes(String(request.method)));
    if (request.body !== undefined) text(request.body);
    if (request.headers !== undefined) {
      requireValue(request.headers && typeof request.headers === "object" && !Array.isArray(request.headers));
      for (const [key, value] of Object.entries(request.headers)) {
        requireValue(/^[a-zA-Z0-9-]+$/.test(key));
        text(value, 8192);
        requireValue(!/[\r\n]/.test(value));
      }
    }
  } else if (args.length > 0) {
    projectPath(args[0], channel !== "project:remove" && channel !== "project:writeBinary");
    if (channel === "project:readBinaryRange") {
      const offset = args[1], length = args[2];
      requireValue(typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0);
      requireValue(typeof length === "number" && Number.isSafeInteger(length) && length >= 0 && length <= MAX_IPC_BYTES);
      requireValue(Number.isSafeInteger(Number(offset) + Number(length)));
      if (args[3] !== undefined) text(args[3], 4096);
    }
    if (channel === "project:writeBinary") requireValue(args[1] instanceof ArrayBuffer && args[1].byteLength <= MAX_IPC_BYTES);
    if (channel === "project:mkdir") requireValue(args[1] === undefined || typeof args[1] === "boolean");
  }
}
