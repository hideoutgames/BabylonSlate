import { useSyncExternalStore } from "react";
import {
  RELEASES_URL,
  getApplicationVersion,
  releaseNotesFromGitHub,
  type GitHubRelease,
  type ReleaseNotes,
} from "../lib/changelog";
import { getBuildIdentity } from "../lib/build-identity";

export type ReleaseNotesState =
  | { status: "idle" | "loading" | "failed"; releases: [] }
  | { status: "loaded"; releases: ReleaseNotes[] };

const FETCH_TIMEOUT_MS = 15_000;

let state: ReleaseNotesState = { status: "idle", releases: [] };
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ReleaseNotesState) {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Reads release notes from GitHub Releases once per launch; later calls reuse
 * that result, so reopening the Changelog never refetches. A failure stays
 * failed until the app is reopened. There is no offline copy.
 */
export function loadReleaseNotes(fetchReleases: typeof fetch = fetch): Promise<void> {
  request ??= (async () => {
    publish({ status: "loading", releases: [] });
    try {
      const response = await fetchReleases(RELEASES_URL, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub Releases responded ${response.status}`);
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) throw new Error("GitHub Releases returned an unexpected response");
      publish({
        status: "loaded",
        releases: releaseNotesFromGitHub(releases as GitHubRelease[], {
          version: getApplicationVersion(),
          includePrereleases: getBuildIdentity()?.channel !== "release",
        }),
      });
    } catch (error) {
      console.warn("Could not load release notes:", error);
      publish({ status: "failed", releases: [] });
    }
  })();
  return request;
}

export function useReleaseNotes(): ReleaseNotesState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
