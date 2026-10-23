import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { BreakpointLocation } from "@haptic/bridge";
import { BreakpointSettingsDialog } from "../components/breakpoint-settings-dialog";
import type { BreakpointStore } from "../services/breakpoint-store";
import type { ConditionPin } from "./breakpoint-settings";

/** The node a host is editing the breakpoint of. */
export type BreakpointSettingsTarget = {
  location: BreakpointLocation;
  nodeTitle: string;
  /** See `BreakpointSettingsDialog`'s `pins`. */
  pins: readonly ConditionPin[] | null;
};

const unsubscribed = () => () => {};
const noEntry = () => undefined;

/**
 * Edit Breakpoint for a node menu: `edit` opens the dialog on a node, `dialog` renders it while open, and Save
 * stores the settings. The dialog closes when its breakpoint is removed.
 */
export function useBreakpointSettingsEditor(store: BreakpointStore | null): {
  edit: (target: BreakpointSettingsTarget) => void;
  dialog: ReactNode;
} {
  const [target, setTarget] = useState<BreakpointSettingsTarget | null>(null);
  const entry = useSyncExternalStore(
    store?.subscribe ?? unsubscribed,
    store && target ? () => store.get(target.location) : noEntry,
  );
  const dialog = store && target && entry ? (
    <BreakpointSettingsDialog
      key={JSON.stringify(target.location)}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      nodeTitle={target.nodeTitle}
      pins={target.pins}
      settings={entry}
      pinName={entry.label.pinName}
      onSave={(settings, pinName) => store.setSettings(target.location, settings, pinName)}
    />
  ) : null;
  return { edit: setTarget, dialog };
}
