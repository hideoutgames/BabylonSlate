import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ExtensionMenuId } from "@haptic/assets";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { useRegistryState } from "../context/document-context";
import type { EditorExtensionCommandDescriptor, ExtensionMenuContext } from "../lib/editor-extension-host";
import { extensionMenuEntries } from "../lib/extension-menus";
import { resolvePluginIcon } from "../lib/plugin-icons";

export type RunExtensionCommand = (command: EditorExtensionCommandDescriptor, context: ExtensionMenuContext) => void;

/** Provided by `ExtensionCommandHost`; menus outside it list no extension entries. */
export const ExtensionCommandContext = createContext<RunExtensionCommand | null>(null);

/**
 * The entries enabled extensions add to `menu`, ready to append to its items
 * (a separator first). `context` is read when an entry is chosen.
 */
export function useExtensionMenuItems(menu: ExtensionMenuId, context: () => ExtensionMenuContext): NestedMenuItem[] {
  const { extensionService } = useRegistryState();
  const snapshot = useSyncExternalStore(extensionService.subscribe, extensionService.getSnapshot);
  const run = useContext(ExtensionCommandContext);
  return useMemo(() => {
    if (!run) return [];
    const entries = extensionMenuEntries(snapshot.entries, snapshot.commands, menu);
    if (entries.length === 0) return [];
    return [
      { type: "separator", id: `extensions-${menu}-separator` },
      ...entries.map((entry): NestedMenuItem => {
        const Icon = resolvePluginIcon(entry.iconKey);
        return {
          type: "item",
          id: `extension-${entry.command.extensionId}-${entry.command.id}`,
          label: entry.label,
          ...(Icon ? { icon: <Icon /> } : {}),
          testId: `extension-menu-${menu}-${entry.command.id}`,
          onSelect: () => run(entry.command, context()),
        };
      }),
    ];
  }, [context, menu, run, snapshot]);
}

