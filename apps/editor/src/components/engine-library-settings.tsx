import { useEffect, useRef, useState } from "react";
import { OctagonAlertIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { Badge } from "@haptic/ui/components/badge";
import { Switch } from "@haptic/ui/components/switch";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@haptic/ui/components/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { resolvePluginIcon } from "../lib/plugin-icons";

export interface EngineLibrarySettingsEntry {
  bundled: boolean;
  enabledByDefault: boolean;
  /** Unreadable entries stay listed so they can be deleted, never exported or enabled. */
  invalid?: string;
  settings: {
    displayName: string;
    iconKey: string | null;
    experimental: boolean;
    beta: boolean;
    version: string;
    description: string;
  };
}

interface EngineLibrary<Entry> {
  list(): Promise<Entry[]>;
  export(guid: string): Promise<Uint8Array>;
  setEnabledByDefault(guid: string, enabled: boolean): Promise<void>;
  remove(guid: string): Promise<void>;
}

/** Engine Settings page for an app-owned library (Engine Plugins, Engine Extensions) of new-project defaults. */
export function EngineLibrarySettings<Entry extends EngineLibrarySettingsEntry>({
  kind,
  ensureLibrary,
  guidOf,
  download,
}: {
  kind: "Plugin" | "Extension";
  ensureLibrary: () => Promise<EngineLibrary<Entry>>;
  guidOf: (entry: Entry) => string;
  download: (bytes: Uint8Array, displayName: string) => void;
}) {
  const id = kind.toLowerCase();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Entry | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void ensureLibrary()
      .then((library) => library.list())
      .then((listed) => {
        if (active) setEntries(listed);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [ensureLibrary, loadVersion]);

  const run = async (action: (library: EngineLibrary<Entry>) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // One library per action: an uncached fallback library re-reads the bundled index.
      const library = await ensureLibrary();
      await action(library);
      setEntries(await library.list());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <FieldSet data-testid={`engine-${id}s-settings`}>
      <FieldLegend>Engine {kind}s</FieldLegend>
      <FieldDescription>
        Copied into new projects. Existing projects keep their own copies.
      </FieldDescription>
      {loading ? <p role="status">Loading Engine {kind}s…</p> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Engine {kind} Action Failed</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-fit"
              disabled={busy || loading}
              onClick={() => setLoadVersion((value) => value + 1)}
            >
              Reload
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {entries.map((entry) => {
        const guid = guidOf(entry);
        const Icon = resolvePluginIcon(entry.settings.iconKey);
        return (
          <Field
            key={guid}
            className="rounded-md border border-border p-3"
            data-testid={`engine-${id}-row-${guid}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">
                  {entry.settings.displayName}
                </span>
                {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
                <Badge variant="outline">
                  {entry.bundled ? "Bundled" : "User Added"}
                </Badge>
                {entry.settings.experimental ? (
                  <Badge variant="secondary">Experimental</Badge>
                ) : null}
                {entry.settings.beta ? (
                  <Badge variant="secondary">Beta</Badge>
                ) : null}
                <span className="text-sm text-muted-foreground">
                  v{entry.settings.version}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || loading || Boolean(entry.invalid)}
                  onClick={() =>
                    void run(async (library) => {
                      download(await library.export(guid), entry.settings.displayName);
                    })
                  }
                >
                  Export
                </Button>
                {!entry.bundled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || loading}
                    onClick={() => setConfirmDelete(entry)}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>
            {entry.invalid ? (
              <Alert variant="destructive">
                <AlertTitle>Invalid {kind}</AlertTitle>
                <AlertDescription>{entry.invalid}</AlertDescription>
              </Alert>
            ) : null}
            {entry.settings.description ? (
              <FieldDescription>{entry.settings.description}</FieldDescription>
            ) : null}
            <Field orientation="horizontal" className="pt-1">
              <FieldContent>
                {/* The label names the switch (it overrides aria-label), so keep it unique per row. */}
                <FieldLabel htmlFor={`engine-${id}-default-${guid}`}>
                  Enable {entry.settings.displayName} By Default
                </FieldLabel>
              </FieldContent>
              <Switch
                id={`engine-${id}-default-${guid}`}
                aria-label={`Enable ${entry.settings.displayName} By Default`}
                checked={!entry.invalid && entry.enabledByDefault}
                disabled={busy || loading || Boolean(entry.invalid)}
                onCheckedChange={(enabled) =>
                  void run((library) => library.setEnabledByDefault(guid, enabled === true))
                }
              />
            </Field>
          </Field>
        );
      })}
      {!loading && !error && entries.length === 0 ? (
        <FieldDescription>
          No Engine {kind}s. Export a project {id} to Engine {kind}s to add
          one.
        </FieldDescription>
      ) : null}
      <AlertDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent variant="destructive">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <OctagonAlertIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete Engine {kind}</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {confirmDelete?.settings.displayName} from Engine {kind}s?
              Existing projects keep their copies. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!confirmDelete) return;
                const guid = guidOf(confirmDelete);
                setConfirmDelete(null);
                void run((library) => library.remove(guid));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldSet>
  );
}
