import { ArrowUpRightIcon } from "lucide-react";
import { buttonVariants } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { DiscordIcon } from "../lib/discord-icon";

/** Haptic's community server: a permanent invite. */
export const HAPTIC_DISCORD_URL = "https://discord.gg/7uPR4JK5q3";

/**
 * The Homepage sidebar's invite to the Discord server, above the account
 * divider. A real link with button styling: Base UI's Button would announce
 * it as a button.
 */
export function HomepageDiscordBadge() {
  return (
    <a
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "homepage-sidebar-badge",
      )}
      href={HAPTIC_DISCORD_URL}
      target="_blank"
      rel="noreferrer"
    >
      <DiscordIcon className="homepage-sidebar-badge-icon" />
      <span className="homepage-sidebar-badge-label">Join our Discord</span>
      <ArrowUpRightIcon className="homepage-sidebar-badge-external" />
    </a>
  );
}
