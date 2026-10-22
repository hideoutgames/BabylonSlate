import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { SelectableText } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { FieldDescription, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";

/** Shape of `lib/third-party-notices.json`, written by `scripts/third-party-notices.mjs`. */
export interface ThirdPartyNotices {
  packages: {
    name: string;
    version: string;
    license: string;
    source: string;
    inGames: boolean;
    /** Index into `texts`; packages with identical notices share one entry. */
    text: number;
  }[];
  texts: string[];
}

/** Loaded on demand so the notices stay out of the main bundle. */
const loadNotices = () =>
  import("../lib/third-party-notices.json").then(module => module.default as ThirdPartyNotices);

/** The Application page's last group: a row that opens the Third-Party Notices page. */
export function ThirdPartyNoticesEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <FieldSet>
      <FieldLegend>Legal</FieldLegend>
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-between gap-3 py-2 text-left pointer-coarse:min-h-11"
        data-testid="application-third-party-notices"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>Third-Party Notices</span>
          <span className="whitespace-normal text-xs font-normal text-muted-foreground">
            Open-source software in Haptic and in the games you export, with each licence.
          </span>
        </span>
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </FieldSet>
  );
}

/** Every bundled open-source package with its licence text, behind a Back button. */
export function ThirdPartyNoticesPage({
  onBack,
  load = loadNotices,
}: {
  onBack: () => void;
  load?: () => Promise<ThirdPartyNotices>;
}) {
  const [notices, setNotices] = useState<ThirdPartyNotices | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      result => { if (live) setNotices(result); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [load]);

  return (
    <div className="homepage-account-center-page" data-testid="third-party-notices-page">
      <div className="flex flex-col items-start gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon data-icon="inline-start" />
          Application
        </Button>
        <h3 className="text-[15px] font-semibold">Third-Party Notices</h3>
        <FieldDescription className="homepage-account-center-note">
          Haptic is built with the open-source software below. Entries marked
          {" "}<strong>In Games</strong> also ship in every game you export, and
          their notices are in <code>legal/THIRD-PARTY-NOTICES.txt</code> inside
          the game ZIP.
        </FieldDescription>
      </div>
      {failed ? (
        <FieldDescription>The notices could not be loaded. Close Account and open it again.</FieldDescription>
      ) : !notices ? (
        <FieldDescription>Loading notices…</FieldDescription>
      ) : (
        <ul className="flex flex-col border-t border-border" aria-label="Third-Party Notices">
          {notices.packages.map(entry => {
            const key = `${entry.name}@${entry.version}`;
            const expanded = open === key;
            const contentId = `third-party-notice-${key.replace(/[^\w-]/g, "-")}`;
            const Icon = expanded ? ChevronDownIcon : ChevronRightIcon;
            return (
              <li key={key} className="border-b border-border">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-2 py-1.5 text-left pointer-coarse:min-h-11"
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  onClick={() => setOpen(expanded ? null : key)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.name}
                    {entry.version && <span className="ml-1.5 text-muted-foreground">{entry.version}</span>}
                  </span>
                  {entry.inGames && <Badge variant="secondary">In Games</Badge>}
                  <Badge variant="outline">{entry.license}</Badge>
                </Button>
                <div id={contentId} hidden={!expanded} className="flex flex-col gap-2 px-2 pb-3 pt-1">
                  {expanded && (
                    <>
                      {entry.source && (
                        <p className="homepage-account-center-note">
                          <a href={entry.source} target="_blank" rel="noreferrer">
                            Source
                            <ExternalLinkIcon aria-hidden="true" />
                          </a>
                        </p>
                      )}
                      <SelectableText className="block max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                        {notices.texts[entry.text]}
                      </SelectableText>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
