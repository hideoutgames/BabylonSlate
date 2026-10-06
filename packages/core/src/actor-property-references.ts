import { assetVariableGuidsFromGraph } from "./asset-variable-references";
import { classIdsFromVariableMembers } from "./class-variable-references";
import type { GraphClassMember } from "./project";

export type ActorPropertyReferenceClass = { parentClassId?: string | null; members?: readonly GraphClassMember[] };

/** Resolve typed instance/default overrides, never arbitrary authored text. Includes nested switcher entries. */
export function actorPropertyReferences(value: unknown, classById: (classId: string) => ActorPropertyReferenceClass | null | undefined): { assetGuids: string[]; classIds: string[] } {
  const assetGuids = new Set<string>(), classIds = new Set<string>();
  const schemas = new Map<string, GraphClassMember[]>();
  const membersFor = (classId: string): GraphClassMember[] => {
    const cached = schemas.get(classId);
    if (cached) return cached;
    const chain: ActorPropertyReferenceClass[] = [], seen = new Set<string>();
    let current: string | null | undefined = classId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const schema = classById(current);
      if (!schema) break;
      chain.unshift(schema);
      current = schema.parentClassId;
    }
    const members = new Map<string, GraphClassMember>();
    for (const schema of chain) for (const member of schema.members ?? []) if (member.kind === "variable" && !member.functionId) members.set(member.propertyKey ?? member.name, member);
    const result = [...members.values()];
    schemas.set(classId, result);
    return result;
  };
  const visit = (source: unknown): void => {
    if (!source || typeof source !== "object") return;
    if (Array.isArray(source)) { source.forEach(visit); return; }
    const record = source as Record<string, unknown>;
    if (typeof record.classId === "string") {
      for (const candidate of [record.properties, record.defaults]) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const properties = candidate as Record<string, unknown>;
        const members = membersFor(record.classId).filter(member => Object.hasOwn(properties, member.propertyKey ?? member.name)).map(member => ({ ...member, defaultValue: properties[member.propertyKey ?? member.name] }));
        for (const guid of assetVariableGuidsFromGraph({ nodes: [], edges: [], members })) assetGuids.add(guid);
        for (const id of classIdsFromVariableMembers(members)) classIds.add(id);
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return { assetGuids: [...assetGuids], classIds: [...classIds] };
}
