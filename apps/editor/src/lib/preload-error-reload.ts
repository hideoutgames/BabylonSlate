const RELOADED_KEY = "slate:preload-error-reloaded";

type PreloadErrorTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "sessionStorage"
> & { location: Pick<Location, "reload"> };

/** True once per session; false when this session already reloaded or storage is unavailable. */
function claimReload(target: PreloadErrorTarget): boolean {
  try {
    if (target.sessionStorage.getItem(RELOADED_KEY)) return false;
    target.sessionStorage.setItem(RELOADED_KEY, "1");
    return true;
  } catch {
    // Without storage a failing chunk could reload forever; leave it to the route error boundary.
    return false;
  }
}

/**
 * Loads the deployed build into this tab: the one reload for an editor whose build a newer deploy replaced, whether a
 * lazy chunk could not load (automatically, once per session) or a Play worker's files are gone (the user's Reload).
 */
export function reloadForNewBuild(target: Pick<PreloadErrorTarget, "location"> = window): void {
  target.location.reload();
}

/**
 * Vite fires `vite:preloadError` when a lazy chunk cannot be fetched, from a
 * transient server error or because a newer deploy replaced the assets. The
 * first one in a session reloads the page for a consistent build; later ones
 * reach the route error boundary and its Reload action.
 */
export function installPreloadErrorReload(
  target: PreloadErrorTarget = window,
): () => void {
  const onPreloadError = (event: Event) => {
    if (!claimReload(target)) return;
    event.preventDefault();
    reloadForNewBuild(target);
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
