/** A platform listed in the Packaging dialog. */
export interface PackagingTarget {
  id: "web" | "windows" | "linux" | "macos" | "android" | "ios";
  label: string;
  description: string;
  /** False lists the platform under Unavailable; only available targets can be packaged. */
  available: boolean;
}

/** Packaging targets in dialog order. Only Web can be packaged today. */
export const PACKAGING_TARGETS: readonly PackagingTarget[] = [
  { id: "web", label: "Web", description: "ZIP for itch.io or any static web host.", available: true },
  { id: "windows", label: "Windows", description: "Desktop game for Windows.", available: false },
  { id: "linux", label: "Linux", description: "Desktop game for Linux.", available: false },
  { id: "macos", label: "macOS", description: "Desktop game for macOS.", available: false },
  { id: "android", label: "Android", description: "App for Android phones and tablets.", available: false },
  { id: "ios", label: "iOS", description: "App for iPhone and iPad.", available: false },
];
