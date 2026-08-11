import { Capacitor } from "@capacitor/core";

export type HostPlatform = "ios" | "android" | "web";

export function getHostPlatform(): HostPlatform {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") return platform;
  return "web";
}

export function isMobilePlatform(): boolean {
  return getHostPlatform() !== "web";
}
