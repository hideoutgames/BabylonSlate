import { Buffer } from "buffer";

/**
 * isomorphic-git reads a global `Buffer`, which browsers and WKWebView lack
 * (isomorphic-git#1855). Installed once, only when a repository opens, from
 * the `buffer` package that its `sha.js` dependency resolves too.
 */
export function installBufferGlobal(): void {
  const host = globalThis as { Buffer?: unknown };
  host.Buffer ??= Buffer;
}
