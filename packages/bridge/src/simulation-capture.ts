export type SimulationQuiesceRequest = { sessionGeneration: number; requestId: number };
export type SimulationCaptureRequest = SimulationQuiesceRequest & { renderRevision: number; maxBytes?: number };
export type SimulationCaptureIdentity = { generation: number; sceneAssetGuid: string; sceneInstanceId: string; sceneLoadId: number; tickIndex: number; commandRevision: number };
export type SimulationCaptureSummary =
  | { ok: true; identity: SimulationCaptureIdentity; byteSize: number; chunkCount: number }
  | { ok: false; code: "boundary" | "ownership" | "value" | "reference" | "resource" | "budget"; reason: string; path: string; identity: SimulationCaptureIdentity };
