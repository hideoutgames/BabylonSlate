import { useEffect, useState } from "react";
import { getAddNodeHistory } from "@haptic/graph-ui";
import { Button } from "@haptic/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";

/**
 * Engine Settings > Graph: the Add Node History switch and its separate Clear
 * action. Turning history off keeps what is saved; only Clear deletes it.
 */
export function AddNodeHistoryFields({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [empty, setEmpty] = useState(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    const history = getAddNodeHistory();
    void history.load().then(() => {
      if (live) setEmpty(history.isEmpty());
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <Field orientation="horizontal" className="settings-field">
        <FieldContent>
          <FieldLabel htmlFor="setting-graph-add-node-history">
            Add Node History
          </FieldLabel>
          <FieldDescription>
            After you drag from a pin, nodes you often add from that pin are
            listed first. Turning this off keeps the saved history.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="setting-graph-add-node-history"
          data-testid="setting-graph-add-node-history"
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
        />
      </Field>
      <Field orientation="horizontal" className="settings-field justify-between">
        <FieldDescription>
          Forgets every node learned from pins on this device.
        </FieldDescription>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={empty}
          data-testid="setting-graph-add-node-history-clear"
          onClick={() => setConfirming(true)}
        >
          Clear Add Node History
        </Button>
      </Field>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Add Node History</AlertDialogTitle>
            <AlertDialogDescription>
              Add Node returns to its default order for every pin. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="setting-graph-add-node-history-clear-confirm"
              onClick={() => {
                setConfirming(false);
                setEmpty(true);
                void getAddNodeHistory().clear();
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
