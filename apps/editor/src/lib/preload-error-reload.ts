import { recordSessionTrailEvent, SessionTrailEventKind } from "@haptic/core";

const RELOADED_KEY = "haptic:preload-error-reloaded";

type PreloadErrorTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "sessionStorage"
> & {
  location: Pick<Location, "reload">;
  /** Set by `coi-serviceworker.js` once its isolation reload has begun. */
  coiReloading?: boolean;
};

/** True once per session; false when this session already reloaded or storage is unavailable. */
function claimReload(target: PreloadErrorTarget): boolean {
  try {
    if (target.sessionStorage.getItem(RELOADED_KEY)) return false;
    target.sessionStorage.setItem(RELOADED_KEY, "1");
    return true;
  } catch {
    // Without storage a failing chunk could reload forever; leave it to the error boundaries.
    return false;
  }
}

/**
 * A lazy chunk that did not load, thrown to the error boundary of what needed it. Retrying fetches it again; when a
 * newer deploy replaced it, only `reloadForNewBuild` recovers, so the boundary offers both.
 */
export class ChunkLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChunkLoadError";
  }
}

/**
 * Every reload of the page the editor makes: records `reason` in the session trail first, synchronously, so the next
 * report can tell a reload of ours from a page the system stopped.
 */
export function reloadPage(reason: string, target: Pick<PreloadErrorTarget, "location"> = window): void {
  recordSessionTrailEvent(SessionTrailEventKind.reload, reason);
  target.location.reload();
}

/**
 * Loads the deployed build into this tab: the one reload for an editor whose build a newer deploy replaced, whether a
 * lazy chunk could not load (automatically, once per session, or the user's Reload Editor) or a Play worker's files
 * are gone (the user's Reload Editor). `reason` is what the session trail records.
 */
export function reloadForNewBuild(reason: string, target: Pick<PreloadErrorTarget, "location"> = window): void {
  reloadPage(reason, target);
}

/** What a `vite:preloadError` failed on: its error's message, which names the chunk's or stylesheet's URL. */
function preloadFailure(event: Event): string {
  const payload = (event as Event & { payload?: unknown }).payload;
  if (payload instanceof Error) return payload.message;
  return payload === undefined ? "an import (no detail)" : String(payload);
}

/**
 * Vite fires `vite:preloadError` when a lazy chunk cannot be fetched, from a
 * transient server error or because a newer deploy replaced the assets. The
 * first one in a session reloads the page for a consistent build; later ones
 * reach the error boundary of what needed the chunk: a route's Reload, or a
 * document's Retry and Reload Editor.
 *
 * A load that fails while the isolation service worker reloads the page (a
 * first visit) is not a missing chunk: the browser cancelled it, as WebKit does
 * with in-flight module imports. It is cancelled without a reload of its own,
 * so the session keeps its one reload for a newer deploy.
 */
export function installPreloadErrorReload(
  target: PreloadErrorTarget = window,
): () => void {
  const onPreloadError = (event: Event) => {
    const failed = preloadFailure(event);
    if (target.coiReloading) {
      recordSessionTrailEvent(SessionTrailEventKind.chunk, `${failed}; cancelled: the isolation service worker's reload had begun`);
      event.preventDefault();
      return;
    }
    if (!claimReload(target)) {
      recordSessionTrailEvent(SessionTrailEventKind.chunk, `${failed}; no reload: this session already reloaded once (or has no session storage)`);
      return;
    }
    // Recorded before the reload, which may end the page at once.
    recordSessionTrailEvent(SessionTrailEventKind.chunk, `${failed}; reloading the page`);
    event.preventDefault();
    reloadForNewBuild("a failed chunk import", target);
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
