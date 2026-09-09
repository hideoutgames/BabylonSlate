import { parseMapDefaultEntries } from "./map-default";
import type { GraphClassMember } from "./project";

/** Class constraints and defaults, including function locals and Map keys. */
export function classIdsFromVariableMembers(
  members: readonly GraphClassMember[],
): string[] {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  };
  for (const member of members) {
    if (!member || member.kind !== "variable") continue;
    const valueIsClass = member.typeId === "class";
    if (valueIsClass) add(member.typeClassId);
    if (member.container === "map") {
      const keyIsClass = member.keyTypeId === "class";
      if (keyIsClass) add(member.keyTypeClassId);
      for (const entry of parseMapDefaultEntries(member.defaultValue)) {
        if (keyIsClass) add(entry.key);
        if (valueIsClass) add(entry.value);
      }
    } else if (valueIsClass && member.container === "array") {
      if (Array.isArray(member.defaultValue)) member.defaultValue.forEach(add);
    } else if (valueIsClass) {
      add(member.defaultValue);
    }
  }
  return [...ids];
}
