/** A Play session that could not load because a newer deploy replaced the editor's build: the report offers Reload. */
export const EDITOR_BUILD_REPLACED_CODE = "editor.build.replaced";

/** What `editorBuildReplaced` reads: the page it runs in and how it fetches. */
export interface BuildStalenessHost {
  document: Pick<Document, "querySelectorAll" | "baseURI">;
  fetch: (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "text">>;
}

/** How long the live page may take to answer before the check gives up and reports nothing. */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * Whether a newer deploy has replaced the build this editor page runs: the live `index.html` (fetched past every cache)
 * no longer names the module scripts the page loaded. A deploy deletes the previous build's hashed chunks, so a worker
 * (or a chunk it imports) the old page asks for no longer exists. False when the page cannot be checked (offline, a dev
 * server, no module scripts), so callers keep their generic report.
 */
export async function editorBuildReplaced(host?: BuildStalenessHost): Promise<boolean> {
  if (!host) {
    if (typeof document === "undefined" || typeof fetch !== "function") return false;
    host = { document, fetch: (input, init) => fetch(input, init) };
  }
  // Hashed build entries only (`assets/index-<hash>.js`): a dev server's `/src/main.tsx` never goes stale.
  const entries = [...host.document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((script) => new URL(script.getAttribute("src") ?? "", host.document.baseURI))
    .filter((url) => /\/assets\/[^/]+-[\w-]{6,}\.js$/.test(url.pathname));
  if (entries.length === 0) return false;
  try {
    // The deploy's index sits one level above its assets, whatever route the page shows.
    const response = await host.fetch(new URL("../", entries[0]!).href, {
      cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const live = await response.text();
    return entries.some((url) => !live.includes(url.pathname.split("/").pop()!));
  } catch {
    return false;
  }
}
