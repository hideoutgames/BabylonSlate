import { useEffect, useRef, useState } from "react";
import { OctagonAlertIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Badge } from "@babylonslate/ui/components/badge";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
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
} from "@babylonslate/ui/components/alert-dialog";
import {
  ensureEngineExtensionLibrary,
  type EngineExtensionEntry,
} from "../lib/engine-extension-library";
import { downloadExtensionArchive } from "../lib/extension-download";
import { resolvePluginIcon } from "../lib/plugin-icons";

export function EngineExtensionsSettings() {
  const [entries, setEntries] = useState<EngineExtensionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<EngineExtensionEntry | null>(
    null,
  );
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void ensureEngineExtensionLibrary()
      .then((library) => library.list())
      .then((extensions) => {
        if (active) setEntries(extensions);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadVersion]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      setEntries(await (await ensureEngineExtensionLibrary()).list());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <FieldSet data-testid="engine-extensions-settings">
      <FieldLegend>Engine Extensions</FieldLegend>
      <FieldDescription>
        Copied into new projects. Existing projects keep their own copies.
      </FieldDescription>
      {loading ? <p role="status">Loading Engine Extensions…</p> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Engine Extension Action Failed</AlertTitle>
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
        const Icon = resolvePluginIcon(entry.settings.iconKey);
        return (
          <Field
            key={entry.extensionGuid}
            className="rounded-md border border-border p-3"
            data-testid={`engine-extension-row-${entry.extensionGuid}`}
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
                    void run(async () => {
                      const library = await ensureEngineExtensionLibrary();
                      downloadExtensionArchive(
                        await library.export(entry.extensionGuid),
                        entry.settings.displayName,
                      );
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
                <AlertTitle>Invalid Extension</AlertTitle>
                <AlertDescription>{entry.invalid}</AlertDescription>
              </Alert>
            ) : null}
            {entry.settings.description ? (
              <FieldDescription>{entry.settings.description}</FieldDescription>
            ) : null}
            <Field orientation="horizontal" className="pt-1">
              <FieldContent>
                <FieldLabel
                  htmlFor={`engine-extension-default-${entry.extensionGuid}`}
                >
                  Enable {entry.settings.displayName} By Default
                </FieldLabel>
              </FieldContent>
              <Switch
                id={`engine-extension-default-${entry.extensionGuid}`}
                aria-label={`Enable ${entry.settings.displayName} By Default`}
                checked={!entry.invalid && entry.enabledByDefault}
                disabled={busy || loading || Boolean(entry.invalid)}
                onCheckedChange={(enabled) =>
                  void run(async () => {
                    await (
                      await ensureEngineExtensionLibrary()
                    ).setEnabledByDefault(entry.extensionGuid, enabled === true);
                  })
                }
              />
            </Field>
          </Field>
        );
      })}
      {!loading && !error && entries.length === 0 ? (
        <FieldDescription>
          No Engine Extensions. Export a project extension to Engine Extensions to add
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
            <AlertDialogTitle>Delete Engine Extension</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {confirmDelete?.settings.displayName} from Engine Extensions?
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
                const guid = confirmDelete.extensionGuid;
                setConfirmDelete(null);
                void run(async () => {
                  await (await ensureEngineExtensionLibrary()).remove(guid);
                });
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
