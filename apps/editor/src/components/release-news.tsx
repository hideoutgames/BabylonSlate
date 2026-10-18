import { useState } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { SelectableText } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { useAppSettings } from "../context/app-settings-context";
import { brandWordmarkSrc } from "../lib/branding";
import { getApplicationVersion, getChangelog, type ReleaseNotes } from "../lib/changelog";

/** One release: its version beside the title and changes. */
function ReleaseEntry({ release, current }: { release: ReleaseNotes; current: boolean }) {
  return (
    <article className="release-news-entry" data-current={current || undefined}>
      <div className="release-news-meta">
        <span className="release-news-version">{release.version}</span>
        {current && <Badge variant="secondary">Current</Badge>}
      </div>
      <div className="release-news-content">
        <h3><SelectableText>{release.title}</SelectableText></h3>
        <ul>
          {release.changes.map((change, index) => <li key={index}><SelectableText>{change}</SelectableText></li>)}
        </ul>
      </div>
    </article>
  );
}

/** One dialog for first-launch news and the account menu's offline history. */
export function ReleaseNews({
  open,
  onOpenChange,
  ready = true,
  announce = !import.meta.env.DEV && !(isTestModeEnabled() && new URLSearchParams(window.location.search).has("test")),
  version = getApplicationVersion(),
  releases = getChangelog(),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ready?: boolean;
  announce?: boolean;
  version?: string;
  releases?: ReleaseNotes[];
}) {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const current = releases.find(release => release.version === version);
  const showNews = Boolean(ready && announce && hydrated && current && dismissed !== version && !settings.seenReleaseVersions.includes(version));
  const news = showNews && !open;
  const visibleReleases = news && current ? [current] : releases;

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
          {news && <img className="release-news-wordmark" src={brandWordmarkSrc()} alt="" />}
          <DialogTitle>{news ? "What's New" : "Changelog"}</DialogTitle>
          <DialogDescription>
            {news ? `Haptic ${version}` : "Every Haptic release, newest first."}
          </DialogDescription>
        </DialogHeader>
        <div className="release-news-body">
          {visibleReleases.length ? visibleReleases.map(release => (
            <ReleaseEntry key={release.version} release={release} current={release.version === version} />
          )) : (
            <Empty><EmptyHeader><EmptyTitle>No Release Notes</EmptyTitle><EmptyDescription>This build has no bundled release notes.</EmptyDescription></EmptyHeader></Empty>
          )}
        </div>
        <DialogFooter>
          {news && <Button size="sm" variant="outline" onClick={() => onOpenChange(true)}>View Changelog</Button>}
          <Button size="sm" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
