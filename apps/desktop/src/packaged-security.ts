import { isAbsolute, relative, resolve } from "node:path";

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
  const file = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
  const within = relative(resolve(root), file);
  requireValue(within !== ".." && !within.startsWith("..") && !isAbsolute(within));
  return file;
}

export function isEditorSender(rawUrl: string, mainFrame: boolean): boolean {
  try {
    const url = new URL(rawUrl);
    return mainFrame && url.protocol === "app:" && url.host === "babylonslate" && !url.username && !url.password && ["/", "/index.html"].includes(url.pathname);
  } catch { return false; }
}

function text(value: unknown, max = 1024 * 1024): asserts value is string {
  requireValue(typeof value === "string" && value.length <= max && !value.includes("\0"));
}

function projectPath(value: unknown, allowRoot = true): void {
  text(value, 4096);
  requireValue(!/[\\:]/.test(value) && !value.startsWith("/") && !value.split("/").includes(".."));
  if (!allowRoot) requireValue(value !== "" && value !== ".");
}

export function validateIpcArguments(channel: string, args: unknown[]): void {
  const counts: Record<string, number> = {
    "settings:read": 0, "settings:write": 1, "secrets:get": 1, "secrets:set": 2, "secrets:delete": 1,
    "lfs:fetch": 1, "project:pickFolder": 0, "project:openDocuments": 1, "project:openKnown": 1,
    "project:list": 0, "project:current": 0, "project:release": 0, "project:readBinary": 1,
    "project:writeBinary": 2, "project:exists": 1, "project:readdir": 1, "project:mkdir": 2,
    "project:remove": 1, "project:stat": 1,
  };
  requireValue(Object.hasOwn(counts, channel) && args.length === counts[channel]);
  if (channel === "settings:write") {
    text(args[0]);
    const parsed: unknown = JSON.parse(args[0]);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } else if (channel.startsWith("secrets:")) {
    text(args[0], 1024);
    requireValue(args[0].length > 0);
    if (channel === "secrets:set") text(args[1]);
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
    if (channel === "project:writeBinary") requireValue(args[1] instanceof ArrayBuffer && args[1].byteLength <= 512 * 1024 * 1024);
    if (channel === "project:mkdir") requireValue(args[1] === undefined || typeof args[1] === "boolean");
  }
}
