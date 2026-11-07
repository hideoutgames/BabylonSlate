import { useState } from "react";
import type { GraphClassMember, SerializedGraph } from "@haptic/core";
import {
  FUNCTION_PIN_PICKER_TYPES,
  PinListEditor,
  type ClassPickerEntry,
  type DelegateSignatureEntry,
  type PinListRow,
} from "@haptic/editor-kit";
import { patchClassMember } from "../lib/class-members";
import {
  committedPinRowIds,
  memberPinRows,
  memberPinsFromRows,
  pinRowIdsFor,
  type CommittedPinRowIds,
} from "./inspector-member-rows";

/**
 * A function's Inputs and Outputs lists. The function shows both; its Input
 * node shows only Inputs and its Output node only Outputs (`only`). An
 * interface implementation's signature comes from its Script Interface, so
 * both lists are read-only there.
 */
export function FunctionPinListEditors({
  graph,
  member,
  only,
  classEntries,
  typeAssets,
  classId,
  delegateSignatures = [],
  onChange,
}: {
  graph: SerializedGraph;
  member: GraphClassMember;
  only?: "in" | "out";
  classEntries: ClassPickerEntry[];
  typeAssets: Array<{ guid: string; name: string; type: string }>;
  /** This document's class id, so signature edits reach only its own Calls. */
  classId?: string;
  /** Event Dispatchers a Delegate type can take its signature from. */
  delegateSignatures?: readonly DelegateSignatureEntry[];
  onChange: (next: SerializedGraph) => void;
}) {
  const [pinRowIds, setPinRowIds] = useState<CommittedPinRowIds | null>(null);
  const inputRows = memberPinRows(member.pins, member.id, "in",
    pinRowIdsFor(pinRowIds, member.id, member.pins, "in"));
  const outputRows = memberPinRows(member.pins, member.id, "out",
    pinRowIdsFor(pinRowIds, member.id, member.pins, "out"));
  const commitPins = (nextInputs: PinListRow[], nextOutputs: PinListRow[]) => {
    const pins = memberPinsFromRows(nextInputs, nextOutputs);
    setPinRowIds(committedPinRowIds(member.id, pins, nextInputs, nextOutputs));
    onChange(patchClassMember(graph, member.id, { pins }, classId));
  };
  const readOnly = Boolean(member.implementsInterface);
  return (
    <>
      {only !== "out" ? (
        <PinListEditor
          title="Inputs"
          rows={inputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          itemLabel="Input"
          testIdPrefix="class-fn-in"
          data-testid="inspector-member-inputs"
          delegateSignatures={delegateSignatures}
          showOptional={false}
          showDefault={false}
          showUnit
          readOnly={readOnly}
          onChange={(nextRows) => commitPins(nextRows, outputRows)}
        />
      ) : null}
      {only !== "in" ? (
        <PinListEditor
          title="Outputs"
          rows={outputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          itemLabel="Output"
          testIdPrefix="class-fn-out"
          data-testid="inspector-member-outputs"
          delegateSignatures={delegateSignatures}
          showOptional={false}
          showDefault={false}
          readOnly={readOnly}
          onChange={(nextRows) => commitPins(inputRows, nextRows)}
        />
      ) : null}
    </>
  );
}
