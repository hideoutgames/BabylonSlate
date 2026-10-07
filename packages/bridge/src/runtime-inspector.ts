import type { MaterialParameterValue, SerializedTransform } from "@babylonslate/core";

/** GUIDs locate candidates; lifetime tokens and scene identity authorize the exact object. */
export type RuntimeObjectIdentity = {
  sceneInstanceId: string;
  actorGuid: string;
  actorToken: number;
  componentGuid?: string;
  componentToken?: number;
};
export type RuntimeInspectorValue = null | boolean | number | string | RuntimeInspectorValue[] | { [key: string]: RuntimeInspectorValue };
export type RuntimePropertyCapability = "live" | "rebuild" | "readOnly" | "restart";
export type RuntimePropertyDescriptor = {
  key: string; name: string; typeId: string; typeClassId?: string;
  container?: "single" | "array" | "map";
  capability: RuntimePropertyCapability; reason?: string;
  value: RuntimeInspectorValue;
};
export type RuntimeIdentityRow = {
  identity: RuntimeObjectIdentity; classId: string; name: string;
  kind: "actor" | "component"; parent: RuntimeObjectIdentity | null;
};
export type RuntimeIdentityCursor = { revision: number; actorIndex: number; componentIndex: number };
export type RuntimeInspectorAction =
  | { kind: "identities"; knownRevision?: number; cursor?: RuntimeIdentityCursor }
  | { kind: "selection"; target: RuntimeObjectIdentity; offset?: number }
  | { kind: "value"; target: RuntimeObjectIdentity; property: string; offset?: number }
  | { kind: "setProperty"; target: RuntimeObjectIdentity; sequence: number; property: string; value: RuntimeInspectorValue }
  | { kind: "setTransform"; target: RuntimeObjectIdentity; sequence: number; transform: SerializedTransform; space?: "local" | "world" }
  | { kind: "setMaterialParameter"; target: RuntimeObjectIdentity; sequence: number; materialGuid: string; parameter: string; value: MaterialParameterValue };
export type RuntimeInspectorRequest = { sessionGeneration: number; requestId: number; action: RuntimeInspectorAction };
export type RuntimeInspectorPayload =
  | { kind: "identities"; rows: RuntimeIdentityRow[]; unchanged: boolean; nextCursor?: RuntimeIdentityCursor }
  | { kind: "selection"; target: RuntimeObjectIdentity; classId: string; transform: SerializedTransform; transformCapability: RuntimePropertyCapability; transformReason?: string;
      properties: RuntimePropertyDescriptor[]; nextOffset?: number }
  | { kind: "value"; property: string; value: RuntimeInspectorValue; nextOffset?: number }
  | { kind: "mutation"; target: RuntimeObjectIdentity; sequence: number; effectiveValue: RuntimeInspectorValue };
export type RuntimeInspectorResult = {
  sessionGeneration: number; requestId: number; success: boolean; reason?: string;
  tickIndex: number; frameId: number; commandRevision: number; structuralRevision: number;
  /** True when a value/page exceeds a transport bound; never means a partial write. */
  truncated?: boolean; payload?: RuntimeInspectorPayload;
};
