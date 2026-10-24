import { useId, useRef, useState } from "react";
import type { BreakpointCondition, BreakpointConditionOp } from "@haptic/bridge";
import { NumberField } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import {
  CONDITION_OP_LABEL,
  CONDITION_OPS,
  type BreakpointSettings,
  type ConditionPin,
  type ConditionValueKind,
} from "../lib/breakpoint-settings";

const NO_CONDITION = "none";
const keyOf = (pin: ConditionPin) => `${pin.direction}:${pin.id}`;
const conditionKey = (condition: BreakpointCondition) => `${condition.direction}:${condition.pinId}`;

/** The kind a saved condition compares, for a pin the node no longer offers. */
function kindOfCondition({ op, value }: BreakpointCondition): ConditionValueKind {
  if (op === "isValid" || op === "isNotValid") return "object";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "string" ? "string" : "number";
}

function operandDraft(condition: BreakpointCondition | undefined): string {
  return condition?.value === undefined ? "" : String(condition.value);
}

export interface BreakpointSettingsDialogProps {
  onOpenChange: (open: boolean) => void;
  nodeTitle: string;
  /** The pins a condition can read; null where nodes have no pins (Behaviour Tree and State Machine nodes). */
  pins: readonly ConditionPin[] | null;
  settings: BreakpointSettings;
  /** The name the saved condition's pin had, for a pin the node no longer offers. */
  pinName?: string;
  onSave: (settings: BreakpointSettings, pinName: string | undefined) => void;
}

/**
 * A breakpoint's condition (one comparison on one pin) and hit count. Mount it per use: the fields start
 * from `settings`.
 */
export function BreakpointSettingsDialog({ onOpenChange, nodeTitle, pins, settings, pinName, onSave }: BreakpointSettingsDialogProps) {
  const id = useId();
  const saved = settings.condition;
  // A pin unwired since the condition was set stays listed, so opening the dialog never drops it.
  const offered: readonly ConditionPin[] = pins && saved && !pins.some((pin) => keyOf(pin) === conditionKey(saved))
    ? [...pins, { id: saved.pinId, direction: saved.direction, name: pinName ?? saved.pinId, kind: kindOfCondition(saved) }]
    : pins ?? [];
  const [pinKey, setPinKey] = useState(saved ? conditionKey(saved) : NO_CONDITION);
  const [op, setOp] = useState<BreakpointConditionOp | undefined>(saved?.op);
  const [operand, setOperand] = useState(operandDraft(saved));
  const [operandError, setOperandError] = useState<string | null>(null);
  const [onlyOnHit, setOnlyOnHit] = useState(settings.hitCount !== undefined);
  const [hitCount, setHitCount] = useState(settings.hitCount ?? 1);
  const finishHitCount = useRef<() => number | undefined>(null);

  const pin = offered.find((candidate) => keyOf(candidate) === pinKey);
  const ops = pin ? CONDITION_OPS[pin.kind] : [];
  const activeOp = op && ops.includes(op) ? op : ops[0];

  const choosePin = (key: string) => {
    setPinKey(key);
    setOperandError(null);
    const next = offered.find((candidate) => keyOf(candidate) === key);
    if (next?.kind === "boolean") setOperand("true");
    else if (next && next.kind !== pin?.kind) setOperand("");
  };

  const condition = (): BreakpointCondition | null | undefined => {
    if (!pin || !activeOp) return undefined;
    const base = { pinId: pin.id, direction: pin.direction, op: activeOp };
    switch (pin.kind) {
      case "object": return base;
      case "boolean": return { ...base, value: operand !== "false" };
      case "string": return { ...base, value: operand };
      case "number": {
        const value = Number(operand.trim());
        if (operand.trim() === "" || !Number.isFinite(value)) {
          setOperandError("Enter a number.");
          return null;
        }
        return { ...base, value };
      }
    }
  };

  const save = () => {
    const next = condition();
    if (next === null) return;
    let count: number | undefined;
    if (onlyOnHit) {
      count = finishHitCount.current?.();
      if (count === undefined) return;
    }
    onSave({ ...(next ? { condition: next } : {}), ...(count !== undefined ? { hitCount: count } : {}) }, next ? pin?.name : undefined);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="breakpoint-settings-dialog">
        <DialogHeader>
          <DialogTitle>Edit Breakpoint</DialogTitle>
          <DialogDescription>
            {pins
              ? `${nodeTitle} counts a run when the condition holds. With a hit count, only that run stops.`
              : `With a hit count, only that run of ${nodeTitle} stops.`}
            {" "}Counting starts with each Simulation or Play.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-3">
          {pins ? (
            <Field>
              <FieldLabel htmlFor={`${id}-pin`}>Condition</FieldLabel>
              <Select value={pinKey} onValueChange={(value) => choosePin(String(value))}>
                <SelectTrigger id={`${id}-pin`} size="sm" className="w-full" data-testid="breakpoint-condition-pin">
                  <SelectValue>{pin ? pin.name : "None"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CONDITION}>None</SelectItem>
                  {(["in", "out"] as const).map((direction) => {
                    const group = offered.filter((candidate) => candidate.direction === direction);
                    return group.length > 0 ? (
                      <SelectGroup key={direction}>
                        <SelectLabel>{direction === "in" ? "Inputs" : "Outputs"}</SelectLabel>
                        {group.map((candidate) => (
                          <SelectItem key={keyOf(candidate)} value={keyOf(candidate)}>{candidate.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null;
                  })}
                </SelectContent>
              </Select>
              {pin && activeOp ? (
                <div className="flex items-start gap-2">
                  <Select value={activeOp} onValueChange={(value) => setOp(value as BreakpointConditionOp)}>
                    <SelectTrigger size="sm" aria-label="Comparison" className={pin.kind === "object" ? "w-full" : "w-28"} data-testid="breakpoint-condition-op">
                      <SelectValue>{CONDITION_OP_LABEL[activeOp]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {ops.map((candidate) => (
                        <SelectItem key={candidate} value={candidate}>{CONDITION_OP_LABEL[candidate]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {pin.kind === "boolean" ? (
                    <Select value={operand === "false" ? "false" : "true"} onValueChange={(value) => setOperand(String(value))}>
                      <SelectTrigger size="sm" aria-label="Value" className="min-w-0 flex-1" data-testid="breakpoint-condition-value">
                        <SelectValue>{operand === "false" ? "False" : "True"}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">True</SelectItem>
                        <SelectItem value="false">False</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : pin.kind === "object" ? null : (
                    <div className="grid min-w-0 flex-1 gap-1">
                      <Input
                        aria-label="Value"
                        aria-invalid={operandError ? true : undefined}
                        className="h-7"
                        inputMode={pin.kind === "number" ? "decimal" : "text"}
                        value={operand}
                        data-testid="breakpoint-condition-value"
                        onChange={(event) => {
                          setOperand(event.target.value);
                          setOperandError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") save();
                        }}
                      />
                      {operandError ? <FieldError>{operandError}</FieldError> : null}
                    </div>
                  )}
                </div>
              ) : null}
            </Field>
          ) : null}
          <Field orientation="horizontal" className="items-center">
            <Checkbox
              id={`${id}-hit`}
              checked={onlyOnHit}
              data-testid="breakpoint-hit-enabled"
              onCheckedChange={(checked) => setOnlyOnHit(checked === true)}
            />
            <FieldLabel htmlFor={`${id}-hit`} className="flex-1 font-normal">Stop Only On Hit</FieldLabel>
            <NumberField
              aria-label="Hit Count"
              className="h-7 w-20"
              integer
              min={1}
              disabled={!onlyOnHit}
              value={hitCount}
              data-testid="breakpoint-hit-count"
              onChange={setHitCount}
              onEnter={save}
              finishRef={finishHitCount}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" size="sm" data-testid="breakpoint-settings-save" onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
