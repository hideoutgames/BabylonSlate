import type { LucideIcon, LucideProps } from "lucide-react";
import SiDiscord from "@icons-pack/react-simple-icons/icons/SiDiscord";
import { createElement, forwardRef } from "react";

const LUCIDE_ONLY_PROPS = new Set(["color", "strokeWidth", "absoluteStrokeWidth"]);

/**
 * Discord's mark from Simple Icons, filled with its `--platform-discord` token (Discord's blurple) wherever it shows.
 * Lucide props that do not apply to a filled mark are dropped.
 */
export const DiscordIcon = forwardRef<SVGSVGElement, LucideProps>(function DiscordIcon({ size, style, ...props }, ref) {
  const svgProps = Object.fromEntries(Object.entries(props).filter(([key]) => !LUCIDE_ONLY_PROPS.has(key)));
  return createElement(SiDiscord, { ...svgProps, ref, size: size ?? 24, color: "currentColor", style: { ...style, color: "var(--platform-discord)" } });
}) as LucideIcon;
