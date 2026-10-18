import { useState } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { useAppSettings } from "../context/app-settings-context";
import { brandWordmarkSrc } from "../lib/branding";
import { getApplicationVersion, getReleaseNotes, type ReleaseNotes } from "../lib/changelog";

/** The current version's notes: its title and changes. */
function ReleaseEntry({ release }: { release: ReleaseNotes }) {
  return (
    <article className="release-news-entry">
      <h3><SelectableText>{release.title}</SelectableText></h3>
      <ul>
        {release.changes.map((change, index) => <li key={index}><SelectableText>{change}</SelectableText></li>)}
      </ul>
    </article>
  );
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

/** The current version's notes, embedded at build time: first-launch news, and the account menu's Changelog. */
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
  const showNews = Boolean(ready && announce && hydrated && current && dismissed !== version && !settings.seenReleaseVersions.includes(version));
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
        data-testid="release-news"
        data-mode={news ? "news" : "history"}
      >
        <DialogHeader className="release-news-header">
          <div className="release-news-brand">
            <img className="release-news-wordmark" src={brandWordmarkSrc()} alt="" />
            <span className="release-news-divider" aria-hidden="true" />
            <DialogTitle>{news ? "What's New" : "Changelog"}</DialogTitle>
            <DialogDescription className="release-news-version">
              <span className="sr-only">Haptic </span>{version}
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
