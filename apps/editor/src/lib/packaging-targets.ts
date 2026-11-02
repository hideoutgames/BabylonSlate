/** A platform the Packaging dialog can build for. */
export interface PackagingTarget {
  id: "web";
  label: string;
  description: string;
}

/**
 * Packaging targets in dialog order. Web builds on every host; native targets
 * (Windows, Linux, macOS, Android, iOS) join this list with the hosts that can
 * build them, so each device offers only what it supports.
 */
export const PACKAGING_TARGETS: readonly PackagingTarget[] = [
  { id: "web", label: "Web", description: "ZIP for itch.io or any static web host." },
];
