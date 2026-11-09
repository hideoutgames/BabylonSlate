import type { BuildPlatform } from "@haptic/core";
import type { GameShellTarget } from "./game-shells";

/** A platform listed in the Packaging dialog. */
export interface PackagingTarget {
  /** The platform the package runs on: its platform directives and modules apply. */
  id: BuildPlatform;
  label: string;
  description: string;
  /** False lists the platform under Unavailable; only available targets can be packaged. */
  available: boolean;
  /** Desktop platforms: the player this copy of Haptic packages them with. */
  desktopTarget?: GameShellTarget;
}

const TARGETS: readonly Omit<PackagingTarget, "available">[] = [
  { id: "web", label: "Web", description: "ZIP for itch.io or any static web host." },
  { id: "windows", label: "Windows", description: "Desktop game for 64-bit Windows, as a ZIP.", desktopTarget: "windows-x64" },
  { id: "linux", label: "Linux", description: "Desktop game for 64-bit Linux, as a Debian package or a ZIP.", desktopTarget: "linux-x64" },
  { id: "macos", label: "macOS", description: "Desktop game for Apple Silicon Macs, as a signed app in a ZIP.", desktopTarget: "macos-arm64" },
  { id: "android", label: "Android", description: "App for Android phones and tablets." },
  { id: "ios", label: "iOS", description: "App for iPhone and iPad." },
];

/** Packaging targets in dialog order: Web always, a desktop platform when this copy of Haptic carries its player. */
export function packagingTargets(desktop: ReadonlySet<GameShellTarget>): PackagingTarget[] {
  return TARGETS.map((target) => ({
    ...target,
    available: target.id === "web" || (target.desktopTarget !== undefined && desktop.has(target.desktopTarget)),
  }));
}
