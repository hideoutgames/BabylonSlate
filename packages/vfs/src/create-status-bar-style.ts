import { CapacitorStatusBarStyle } from "./capacitor-status-bar-style";
import { getHostPlatform } from "./platform";
import {
  UnavailableStatusBarStyle,
  type StatusBarStylePort,
} from "./status-bar-style-port";

export function createStatusBarStyle(): StatusBarStylePort {
  const platform = getHostPlatform();
  if (platform === "ios" || platform === "android") {
    return new CapacitorStatusBarStyle();
  }
  return new UnavailableStatusBarStyle();
}
