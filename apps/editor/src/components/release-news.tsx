import { useEffect, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@babylonslate/ui/components/empty";
import { useAppSettings } from "../context/app-settings-context";
import { brandWordmarkSrc } from "../lib/branding";
import { getApplicationVersion, type ReleaseNotes } from "../lib/changelog";
import { loadReleaseNotes, useReleaseNotes, type ReleaseNotesState } from "../services/release-notes";

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

/** What the Changelog shows while notes load, after a failed load, or when none are published. */
function ReleaseNotesStatus({ status, version }: { status: ReleaseNotesState["status"]; version: string }) {
  if (status === "failed") {
    return (
      <Empty data-testid="release-news-failed">
        <EmptyHeader>
          <EmptyTitle>Failed To Load Patch Notes</EmptyTitle>
          <EmptyDescription>Check your connection and reopen Haptic to try again.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (status === "loaded") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No Patch Notes Yet</EmptyTitle>
          <EmptyDescription>Notes for Haptic {version} appear here once it is published.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia><LoaderCircleIcon className="animate-spin" aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>Loading Patch Notes</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/** The current version's notes from GitHub Releases: first-launch news, and the account menu's Changelog. */
export function ReleaseNews({
  open,
  onOpenChange,
  ready = true,
  announce = !import.meta.env.DEV && !(isTestModeEnabled() && new URLSearchParams(window.location.search).has("test")),
  version = getApplicationVersion(),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ready?: boolean;
  announce?: boolean;
  version?: string;
}) {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const notes = useReleaseNotes();
  const releases = notes.releases;
  // QA sessions skip the launch request; this reuses it everywhere else.
  useEffect(() => {
    if (open) void loadReleaseNotes();
  }, [open]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const current = releases.find(release => release.version === version);
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
          {current ? <ReleaseEntry release={current} /> : <ReleaseNotesStatus status={notes.status} version={version} />}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
