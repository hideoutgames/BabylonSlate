import type {
  RenderFramePassDescription,
  RenderFrameReport,
  RenderFrameResource,
  RenderFrameStage,
  RenderFrameTaskDescription,
} from "./render-frame-report";

const FRAME_REPORT_FILE_KIND = "haptic-frame";
const STAGE_KINDS = new Set<string>(["frameGraph", "task", "native", "overlay", "composition", "auxiliary"]);
const BACKENDS = new Set<string>(["webgpu", "webgl2", "webgl1", "unknown"]);

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const arrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const numbers = (value: unknown) => arrayOf(value, isNumber);
const strings = (value: unknown) => arrayOf(value, isString);

function isPass(value: unknown): value is RenderFramePassDescription {
  return isRecord(value) && isString(value.name) && isBoolean(value.disabled) &&
    optional(value.colorTargets, numbers) && optional(value.depthTarget, isNumber);
}

function isTask(value: unknown): value is RenderFrameTaskDescription {
  return isRecord(value) && isNumber(value.id) && isNumber(value.graphId) && isString(value.name) && isString(value.type) &&
    isBoolean(value.disabled) && arrayOf(value.passes, isPass) && arrayOf(value.disabledPasses, isPass) && numbers(value.dependencies);
}

function isStage(value: unknown): value is RenderFrameStage {
  return isRecord(value) && isNumber(value.id) && isString(value.name) && isString(value.kind) && STAGE_KINDS.has(value.kind) &&
    isNumber(value.sceneUniqueId) && isNumber(value.startedAtMs) && isBoolean(value.completed) &&
    optional(value.parentId, isNumber) && optional(value.graphId, isNumber) && optional(value.taskId, isNumber) &&
    optional(value.submissionMs, isNumber) && optional(value.drawCalls, isNumber) && optional(value.fallbackPasses, isBoolean) &&
    optional(value.selectedPasses, strings) && optional(value.sceneId, isString) && optional(value.actorGuid, isString) &&
    optional(value.materialGuid, isString) && optional(value.detail, isString);
}

function isResource(value: unknown): value is RenderFrameResource {
  return isRecord(value) && isNumber(value.graphId) && isNumber(value.handle) && optional(value.width, isNumber) &&
    optional(value.height, isNumber) && optional(value.samples, isNumber) && optional(value.formats, numbers) &&
    optional(value.types, numbers) && optional(value.labels, strings) && optional(value.unavailable, isString);
}

function isFrame(value: unknown): value is RenderFrameReport["frame"] {
  return isRecord(value) && isNumber(value.renderFrameId) && isNumber(value.snapshotFrameId) && isNumber(value.tickId) &&
    isNumber(value.sceneGeneration) && isNumber(value.viewId) && isNumber(value.width) && isNumber(value.height) &&
    isString(value.backend) && BACKENDS.has(value.backend) && optional(value.sceneLoadId, isNumber) &&
    optional(value.sceneAssetGuid, isString);
}

const isGraph = (value: unknown) => isRecord(value) && isNumber(value.id) && isNumber(value.sceneUniqueId) && isNumber(value.generation);

/** The Profiler's frame report export: the report in a versioned envelope. */
export function serializeRenderFrameReport(report: RenderFrameReport): string {
  return JSON.stringify({ kind: FRAME_REPORT_FILE_KIND, version: 1, report });
}

/** An exported frame report read back, or null when the value is not one this version can show. */
export function parseRenderFrameReport(value: unknown): RenderFrameReport | null {
  if (!isRecord(value) || value.kind !== FRAME_REPORT_FILE_KIND || value.version !== 1) return null;
  const report = value.report;
  if (!isRecord(report) || report.version !== 1 || !isFrame(report.frame) || !isBoolean(report.complete) ||
    !isNumber(report.droppedRecords) || !isNumber(report.retainedBytes) || !isNumber(report.byteBudget) ||
    !arrayOf(report.graphs, isGraph) || !arrayOf(report.tasks, isTask) || !arrayOf(report.stages, isStage) ||
    !arrayOf(report.resources, isResource) || !strings(report.limitations)) return null;
  return report as unknown as RenderFrameReport;
}
