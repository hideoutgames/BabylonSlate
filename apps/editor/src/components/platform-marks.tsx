import type { ComponentType } from "react";
import SiHtml5 from "@icons-pack/react-simple-icons/icons/SiHtml5";
import Android from "react-bootstrap-icons/dist/icons/android";
import Apple from "react-bootstrap-icons/dist/icons/apple";
import Tux from "react-bootstrap-icons/dist/icons/tux";
import Windows from "react-bootstrap-icons/dist/icons/windows";
import type { PackagingTarget } from "../lib/packaging-targets";

export type MarkProps = { className?: string; title?: string; "aria-hidden"?: boolean };

/**
 * Platform marks: Bootstrap Icons, and Simple Icons' HTML5 shield for Web
 * (Bootstrap Icons has none). Each is imported from its own module. macOS and
 * iOS share the Apple mark. Brand colours come from the `--platform-*` tokens;
 * Apple and Linux use the text colour.
 */
export const PLATFORM_MARKS: Record<PackagingTarget["id"], { Mark: ComponentType<MarkProps>; color?: string }> = {
  web: { Mark: SiHtml5, color: "text-platform-web" },
  windows: { Mark: Windows, color: "text-platform-windows" },
  linux: { Mark: Tux },
  macos: { Mark: Apple },
  android: { Mark: Android, color: "text-platform-android" },
  ios: { Mark: Apple },
};
