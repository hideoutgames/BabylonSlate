import type {
  EnumAsset,
  ScriptInterfaceAsset,
  StructureAsset,
} from "@babylonslate/scripting";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function asEnumAsset(payload: Record<string, unknown>): EnumAsset {
  const members = Array.isArray(payload.members) ? payload.members : [];
  return {
    kind: "enum",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Enum",
    members: members.map((raw) => {
      const row = asRecord(raw);
      return {
        name: typeof row.name === "string" ? row.name : "Member",
        value: typeof row.value === "number" ? row.value : 0,
      };
    }),
  };
}

export function asStructureAsset(
  payload: Record<string, unknown>,
): StructureAsset {
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  return {
    kind: "structure",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Structure",
    fields: fields.map((raw) => {
      const row = asRecord(raw);
      return {
        ...(typeof row.id === "string" && row.id.trim() ? { id: row.id.trim() } : {}),
        name: typeof row.name === "string" ? row.name : "Field",
        typeId: typeof row.typeId === "string" ? row.typeId : "float",
        ...(typeof row.typeClassId === "string" && row.typeClassId.trim()
          ? { typeClassId: row.typeClassId.trim() }
          : {}),
        ...(row.container === "single" || row.container === "array" || row.container === "map"
          ? { container: row.container }
          : {}),
        ...(typeof row.keyTypeId === "string" && row.keyTypeId.trim()
          ? { keyTypeId: row.keyTypeId.trim() }
          : {}),
        ...(typeof row.keyTypeClassId === "string" && row.keyTypeClassId.trim()
          ? { keyTypeClassId: row.keyTypeClassId.trim() }
          : {}),
        ...(row.defaultValue !== undefined
          ? { defaultValue: row.defaultValue }
          : {}),
      };
    }),
  };
}

export function asScriptInterfaceAsset(
  payload: Record<string, unknown>,
): ScriptInterfaceAsset {
  const methods = Array.isArray(payload.methods) ? payload.methods : [];
  return {
    kind: "scriptInterface",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Interface",
    methods: methods.map((raw) => {
      const row = asRecord(raw);
      const pins = Array.isArray(row.pins) ? row.pins : [];
      return {
        name: typeof row.name === "string" ? row.name : "Method",
        pins: pins.map((pin) => {
          const pinRow = asRecord(pin);
          return {
            name: typeof pinRow.name === "string" ? pinRow.name : "Pin",
            typeId: typeof pinRow.typeId === "string" ? pinRow.typeId : "float",
            direction: pinRow.direction === "out" ? "out" : "in",
            ...(typeof pinRow.typeClassId === "string" && pinRow.typeClassId.trim()
              ? { typeClassId: pinRow.typeClassId.trim() }
              : {}),
          };
        }),
      };
    }),
  };
}

export function memberKey(index: number): string {
  return `member:${index}`;
}

export function parseMemberIndex(id: string | null): number | null {
  if (!id?.startsWith("member:")) return null;
  const index = Number(id.slice("member:".length));
  return Number.isInteger(index) ? index : null;
}

export function pinKey(methodIndex: number, pinIndex: number): string {
  return `pin:${methodIndex}:${pinIndex}`;
}
