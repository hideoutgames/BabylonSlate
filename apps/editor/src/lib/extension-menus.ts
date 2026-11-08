import type { ExtensionDescriptor, ExtensionMenuId } from "@haptic/assets";
import type { EditorExtensionCommandDescriptor } from "./editor-extension-host";

export interface ExtensionMenuEntry {
  label: string;
  iconKey: string | null;
  command: EditorExtensionCommandDescriptor;
}

/**
 * The entries extensions add to `menu`, in extension order. An entry shows
 * only while its extension is running and has registered the named command.
 */
export function extensionMenuEntries(
  entries: readonly ExtensionDescriptor[],
  commands: readonly EditorExtensionCommandDescriptor[],
  menu: ExtensionMenuId,
): ExtensionMenuEntry[] {
  return entries.flatMap((entry) => (entry.invalid ? [] : entry.settings.contributes.menus ?? [])
    .filter((contribution) => contribution.menu === menu)
    .flatMap((contribution) => {
      const command = commands.find((value) => value.extensionId === entry.extensionGuid && value.id === contribution.command);
      return command ? [{ label: contribution.title ?? command.title, iconKey: entry.settings.iconKey, command }] : [];
    }));
}
