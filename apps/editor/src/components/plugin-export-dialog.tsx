import { useRef, useState } from "react";
import type { PluginDescriptor } from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import {
  ensureEnginePluginLibrary,
  type EnginePluginEntry,
} from "../lib/engine-plugin-library";
import { downloadPluginArchive } from "../lib/plugin-download";

export function PluginExportDialog({
  plugin,
  onClose,
  exportPlugin,
}: {
  plugin: PluginDescriptor;
  onClose: () => void;
  exportPlugin: (guid: string) => Promise<Uint8Array>;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    existing: EnginePluginEntry;
    bytes: Uint8Array;
  } | null>(null);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const install = async (bytes: Uint8Array, replaceGuid?: string) => {
    const library = await ensureEnginePluginLibrary();
    const result = await library.import(bytes, { replaceGuid });
    if (result.status === "conflict") {
      setConflict({ existing: result.existing, bytes });
      return;
    }
    setConflict(null);
    onClose();
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busyRef.current) onClose();
        }}
      >
        <DialogContent data-testid="plugin-export-dialog">
          <DialogHeader>
            <DialogTitle>Export Plugin</DialogTitle>
            <DialogDescription>
              Download {plugin.settings.displayName} or add it to Engine Plugins
              for new projects.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Export Failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {busy ? <p role="status">Exporting Plugin…</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const bytes = await exportPlugin(plugin.pluginGuid);
                  downloadPluginArchive(bytes, plugin.settings.displayName);
                  onClose();
                })
              }
            >
              Export To Download
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await install(await exportPlugin(plugin.pluginGuid));
                })
              }
            >
              Export To Engine Plugins
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(conflict)}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setConflict(null);
        }}
      >
        <AlertDialogContent data-testid="engine-plugin-replace-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Engine Plugin</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict?.existing.settings.displayName} already exists in Engine
              Plugins. Replace it with this export? Existing projects keep their
              copies.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!conflict) return;
                const { bytes, existing } = conflict;
                setConflict(null);
                void run(() => install(bytes, existing.pluginGuid));
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
