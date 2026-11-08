import type { SharedOutlineContribution, SharedOutlineView } from "../shared-outline";

/**
 * Tests and test-mode proofs change one outline contribution at a time; production publishes whole snapshots
 * (`SceneOutlineHost`). These helpers publish the view's current contributions with one entry set or removed through
 * `replaceContributions`, the path production takes, without occluders.
 */
export function setOutlineContribution(view: SharedOutlineView, key: string, contribution: SharedOutlineContribution): void {
  view.replaceContributions(new Map(view.contributions).set(key, contribution), null);
}

export function removeOutlineContribution(view: SharedOutlineView, key: string): void {
  const next = new Map(view.contributions);
  if (next.delete(key)) view.replaceContributions(next, null);
}
