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
    target.location.reload();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
