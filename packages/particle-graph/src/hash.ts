import type { ParticleGraphSettings } from "./document";
import type { ParticleOperand, ParticleOperation } from "./lower";

/** 32-bit FNV-1a as 8 hex digits. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Settings with a fixed key order, so the hash never depends on authoring order. */
export function particleSettingsFingerprint(settings: ParticleGraphSettings): string {
  return JSON.stringify([
    settings.capacity,
    settings.loop,
    settings.duration,
    settings.prewarm,
    settings.blendMode,
    settings.billboard,
  ]);
}

function describeOperand(operand: ParticleOperand): string {
  if (operand.kind === "constant") return `c:${operand.type}:${operand.value.join("/")}`;
  const conversion = operand.conversion ? `:${operand.conversion.kind}>${operand.conversion.to}` : "";
  return `o:${operand.operationId}:${operand.pinId}${conversion}`;
}

/**
 * Stable hash of what the simulation builds. Positions, the document name, the
 * Material, unreachable nodes and defaults on wired pins never reach the plan,
 * so they never change the hash.
 */
export function hashParticlePlan(
  settings: ParticleGraphSettings,
  operations: readonly ParticleOperation[],
): string {
  const lines = [particleSettingsFingerprint(settings)];
  for (const operation of operations) {
    const inputs = Object.keys(operation.inputs)
      .sort()
      .map((pinId) => `${pinId}=${describeOperand(operation.inputs[pinId]!)}`)
      .join(",");
    const properties = Object.keys(operation.properties)
      .sort()
      .map((key) => `${key}:${JSON.stringify(operation.properties[key])}`)
      .join(",");
    lines.push(
      `${operation.id}|${operation.nodeType}|${operation.resolvedType ?? "-"}|${inputs}|${properties}`,
    );
  }
  return fnv1a(lines.join("\n"));
}
