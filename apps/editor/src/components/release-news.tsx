import { useState } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { useAppSettings } from "../context/app-settings-context";
import { getApplicationVersion, getChangelog, type ReleaseNotes } from "../lib/changelog";

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
      <DialogContent className="sm:max-w-2xl" data-testid="release-news">
        <DialogHeader>
          <DialogTitle>{news ? "What's New" : "Changelog"}</DialogTitle>
          <DialogDescription>
            {news ? `Welcome To BabylonSlate ${version}` : "BabylonSlate Release History"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60dvh] min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain">
          {visibleReleases.length ? visibleReleases.map(release => (
            <section key={release.version} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium"><SelectableText>{release.version} — {release.title}</SelectableText></h3>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
                {release.changes.map((change, index) => <li key={index}><SelectableText>{change}</SelectableText></li>)}
              </ul>
            </section>
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
