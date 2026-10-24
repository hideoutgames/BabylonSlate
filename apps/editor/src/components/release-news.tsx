import { useEffect, useState } from "react";
import { isTestModeEnabled } from "@haptic/vfs";
import { SelectableText } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@haptic/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { useAppSettings } from "../context/app-settings-context";
import { brandWordmarkSrc } from "../lib/branding";
import { getBuildIdentity } from "../lib/build-identity";
import { getApplicationVersion, getReleaseNotes, type ReleaseNotes } from "../lib/changelog";

/** The current version's changes; the dialog title already names the build. */
function ReleaseEntry({ release }: { release: ReleaseNotes }) {
  return (
    <article className="release-news-entry">
      <ul>
        {release.changes.map((change, index) => <li key={index}><SelectableText>{change}</SelectableText></li>)}
      </ul>
    </article>
  );
}

/** The build's name as players see it: its channel, then its version. */
function buildName(version: string): string {
  const channel = getBuildIdentity()?.channel;
  return `${channel === "release" ? "Release" : channel === "test" ? "Test" : "Development"} ${version}`;
}

/** Shown when the build carries no notes for its version. */
function NoReleaseNotes({ version }: { version: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No Patch Notes</EmptyTitle>
        <EmptyDescription>Haptic {version} has no patch notes.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The current version's notes, embedded at build time: news on the first
 * launch after an update, and the account menu's Changelog. A first install
 * records its version without announcing it.
 */
export function ReleaseNews({
  open,
  onOpenChange,
  ready = true,
  announce = !import.meta.env.DEV && !(isTestModeEnabled() && new URLSearchParams(window.location.search).has("test")),
  version = getApplicationVersion(),
  current = getReleaseNotes(),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ready?: boolean;
  announce?: boolean;
  version?: string;
  current?: ReleaseNotes | null;
}) {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const [dismissed, setDismissed] = useState<string | null>(null);
  // No version seen yet means a fresh install, which has nothing to catch up on.
  const firstLaunch = hydrated && settings.seenReleaseVersions.length === 0;
  const showNews = Boolean(ready && announce && !firstLaunch && hydrated && current && dismissed !== version && !settings.seenReleaseVersions.includes(version));

  useEffect(() => {
    if (!announce || !firstLaunch || !version) return;
    void updateSettings(settings => {
      if (settings.seenReleaseVersions.length === 0) settings.seenReleaseVersions.push(version);
    }).catch(error => console.warn("Could not remember the first launch version:", error));
  }, [announce, firstLaunch, version, updateSettings]);
  const news = showNews && !open;

  function close() {
    onOpenChange(false);
    if (current && (showNews || open)) {
      setDismissed(version);
      void updateSettings(settings => {
        if (!settings.seenReleaseVersions.includes(version)) settings.seenReleaseVersions.push(version);
      }).catch(error => console.warn("Could not remember release news dismissal:", error));
    }
  }

  return (
    <Dialog open={open || showNews} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent
        className="homepage-theme release-news"
        bodyClassName="release-news-frame"
        data-testid="release-news"
        data-mode={news ? "news" : "history"}
      >
        <DialogHeader className="release-news-header">
          <div className="release-news-brand">
            <img className="release-news-wordmark" src={brandWordmarkSrc()} alt="" />
            <span className="release-news-divider" aria-hidden="true" />
            <DialogTitle>{buildName(version)}</DialogTitle>
            <DialogDescription className="sr-only">
              {news ? "What's New" : "Changelog"} for Haptic {version}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="release-news-body">
          {current ? <ReleaseEntry release={current} /> : <NoReleaseNotes version={version} />}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
