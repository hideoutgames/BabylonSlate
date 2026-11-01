import type {
  DelegateSignatureType,
  GraphClassMemberPin,
  SerializedGraph,
} from "@haptic/core";
import type { DelegateSignatureEntry } from "@haptic/editor-kit";
import { delegateSignatureSource } from "@haptic/scripting";

/** The input types of a signature: its data rows, without names, units or exec rows. */
export function signatureOfPins(
  pins: readonly GraphClassMemberPin[] | undefined,
): DelegateSignatureType[] {
  return (pins ?? [])
    .filter((pin) => pin.typeId !== "exec")
    .map((pin) => ({
      typeId: pin.typeId,
      ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
      ...(pin.container && pin.container !== "single" ? { container: pin.container } : {}),
      ...(pin.typeId === "delegate" ? { signature: (pin.signature ?? []).map((input) => ({ ...input })) } : {}),
    }));
}

/**
 * Every Event Dispatcher a Delegate type can take its signature from, by
 * declaring Class then name: the open Class first, then the others.
 */
export function delegateSignatureEntries(
  graphs: Readonly<Record<string, SerializedGraph | undefined>>,
  ownClassId?: string,
): DelegateSignatureEntry[] {
  const entries: DelegateSignatureEntry[] = [];
  const classIds = Object.keys(graphs).sort((left, right) => {
    if (left === ownClassId) return -1;
    if (right === ownClassId) return 1;
    return left.localeCompare(right);
  });
  for (const classId of classIds) {
    const dispatchers = (graphs[classId]?.members ?? [])
      .filter((member) => member.kind === "dispatcher")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const dispatcher of dispatchers) {
      entries.push({
        id: delegateSignatureSource(classId, dispatcher.name),
        label: dispatcher.name,
        description: classId,
        signature: signatureOfPins(dispatcher.pins),
        parameterNames: (dispatcher.pins ?? []).filter((pin) => pin.typeId !== "exec").map((pin) => pin.name),
      });
    }
  }
  return entries;
}
