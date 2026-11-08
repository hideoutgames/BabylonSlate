import { useCallback, useState, type ReactNode } from "react";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { DropdownMenuItem, DropdownMenuSeparator } from "@haptic/ui/components/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@haptic/ui/components/alert-dialog";
import { useRegistryState } from "../context/document-context";
import type { EditorExtensionCommandDescriptor, ExtensionMenuContext } from "../lib/editor-extension-host";
import { ExtensionCommandDialog } from "./project-extension-dialogs";
import { ExtensionCommandContext, type RunExtensionCommand } from "./use-extension-menu-items";


/**
 * Runs extension commands chosen from editor menus: a command with fields opens
 * its dialog with the menu's context; one without runs at once and shows its
 * message or error, if any.
 */
export function ExtensionCommandHost({ children }: { children: ReactNode }) {
  const { extensionService } = useRegistryState();
  const [dialog, setDialog] = useState<{ command: EditorExtensionCommandDescriptor; context: ExtensionMenuContext } | null>(null);
  const [result, setResult] = useState<{ title: string; message: string; failed: boolean } | null>(null);
  const run = useCallback<RunExtensionCommand>((command, context) => {
    if (command.fields.length > 0) {
      setDialog({ command, context });
      return;
    }
    void extensionService.run(command.extensionId, command.id, {}, context).then(
      (message) => { if (message) setResult({ title: command.title, message, failed: false }); },
      (error: unknown) => setResult({ title: command.title, message: error instanceof Error ? error.message : String(error), failed: true }),
    );
  }, [extensionService]);
  return <ExtensionCommandContext.Provider value={run}>
    {children}
    {dialog ? <ExtensionCommandDialog command={dialog.command} context={dialog.context} service={extensionService} onClose={() => setDialog(null)} /> : null}
    <AlertDialog open={result !== null} onOpenChange={(open) => { if (!open) setResult(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{result?.failed ? `${result.title} Failed` : result?.title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">{result?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogAction>OK</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </ExtensionCommandContext.Provider>;
}

/** `useExtensionMenuItems` entries inside a JSX `DropdownMenuContent` (the chrome bar's menus). */
export function ExtensionDropdownMenuItems({ items }: { items: readonly NestedMenuItem[] }) {
  return <>{items.map((item) => item.type === "separator"
    ? <DropdownMenuSeparator key={item.id} />
    : item.type === undefined || item.type === "item"
      ? <DropdownMenuItem key={item.id} data-testid={item.testId} onClick={item.onSelect}>{item.icon}{item.label}</DropdownMenuItem>
      : null)}</>;
}
