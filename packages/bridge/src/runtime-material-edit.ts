import type { MaterialParameterValue } from "@babylonslate/core";
export type RuntimeMaterialEditPreparation = {
  sessionGeneration: number; requestId: number; editToken: string;
  slotId: number; actorGuid: string; componentId: string; materialGuid: string | null;
  parameterName?: string; parameter?: MaterialParameterValue;
};
export type RuntimeMaterialEditResponse = {
  sessionGeneration: number; requestId: number; editToken: string; success: boolean; reason?: string;
};
