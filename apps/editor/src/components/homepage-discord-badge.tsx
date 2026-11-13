import { useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { buttonVariants } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { DiscordIcon } from "../lib/discord-icon";

/** Haptic's community server: a permanent invite. */
export const HAPTIC_DISCORD_URL = "https://discord.gg/7uPR4JK5q3";

/** Per account on this device; guests have nowhere to remember it. */
function dismissedKey(accountId: string): string {
  return `haptic:discord-badge-dismissed:${accountId}`;
}

function wasDismissed(accountId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(accountId)) === "true";
  } catch {
    return false;
  }
}

/**
 * The Homepage sidebar's invite to the Discord server, above the account
 * divider. A signed-in account's first click hides it on this device; the
 * profile menu keeps Discord Server. Nothing shows until the account is known,
 * so a dismissed badge does not flash while sign-in restores. A real link with
 * button styling: Base UI's Button would announce it as a button.
 *
 * `accountId`: the signed-in account, null for a guest, undefined while unknown.
 */
export function HomepageDiscordBadge({
  accountId,
}: {
  accountId: string | null | undefined;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  if (accountId === undefined) return null;
  if (accountId !== null && (clicked === accountId || wasDismissed(accountId)))
    return null;
  return (
    <a
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "homepage-sidebar-badge",
      )}
      href={HAPTIC_DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        if (accountId === null) return;
        try {
          localStorage.setItem(dismissedKey(accountId), "true");
        } catch {
          /* Hidden for this session only. */
        }
        setClicked(accountId);
      }}
    >
      <DiscordIcon className="homepage-sidebar-badge-icon" />
      <span className="homepage-sidebar-badge-label">Join our Discord</span>
      <ArrowUpRightIcon className="homepage-sidebar-badge-external" />
    </a>
  );
}
