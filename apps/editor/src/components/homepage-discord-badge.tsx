import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { DiscordIcon } from "../lib/discord-icon";

/** Haptic's community server: a permanent invite. */
export const HAPTIC_DISCORD_URL = "https://discord.gg/7uPR4JK5q3";

/** The Homepage sidebar's invite to the Discord server, above the account divider. */
export function HomepageDiscordBadge() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="homepage-sidebar-badge"
      nativeButton={false}
      render={<a href={HAPTIC_DISCORD_URL} target="_blank" rel="noreferrer" />}
    >
      <DiscordIcon className="homepage-sidebar-badge-icon" aria-hidden="true" />
      <span className="homepage-sidebar-badge-label">Join our Discord</span>
      <ArrowUpRightIcon
        className="homepage-sidebar-badge-external"
        aria-hidden="true"
      />
    </Button>
  );
}
