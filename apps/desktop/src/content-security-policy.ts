import { createHash } from "node:crypto";

/**
 * Content Security Policies of the desktop app's `app://` pages. Each header
 * is built once, when the protocol handler is installed, and the same string
 * goes on every response.
 */

/** Subframes the editor may host: the Preview player and Web Billing checkout (as `isBillingFrameUrl` allows). */
const EDITOR_FRAME_SOURCES = [
  "app://preview",
  "https://stripe.com", "https://*.stripe.com", "https://stripe.network", "https://*.stripe.network",
  "https://revenuecat.com", "https://*.revenuecat.com", "https://pay.rev.cat",
];

/** `'sha256-…'` sources for each inline `<script>` (one with no `src`) in an HTML page. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(match[1] ?? "")) continue;
    hashes.push(`'sha256-${createHash("sha256").update(match[2] ?? "", "utf8").digest("base64")}'`);
  }
  return hashes;
}

/**
 * The editor page at `app://babylonslate`. It runs code it builds at run time
 * (Extensions, Play's in-process scripts, the particle compiler), compiles
 * WebAssembly (physics, navigation, texture transcoders), loads sign-in and
 * billing scripts and frames from their HTTPS hosts, and reaches HTTPS APIs
 * whose hosts come from configuration (Clerk's Frontend API host is in the
 * publishable key). Inline scripts are allowed only by hash.
 */
export function editorContentSecurityPolicy(inlineScripts: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' ${[...inlineScripts, "https:"].join(" ")}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob: https: wss:",
    `frame-src ${EDITOR_FRAME_SOURCES.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The game player: Preview Build at `app://preview` (embedded only by the
 * editor) and an exported desktop game at `app://game` (never embedded). Both
 * run compiled scripts with `new Function` and compile WebAssembly; texture
 * and mesh decoders start workers from blob URLs, and loaded assets are shown
 * through blob URLs. Nothing reaches the network.
 */
export function playerContentSecurityPolicy(frameAncestors: "'none'" | string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}
