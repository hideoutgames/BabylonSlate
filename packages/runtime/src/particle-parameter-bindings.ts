import { normalizeParticleParameterValues } from "@haptic/assets";
import type { CommandMessage } from "@haptic/bridge";
import { resizeParticleParameterValue } from "@haptic/core";
import type { Actor, ActorComponent } from "@haptic/object-model";
import type { RuntimeParticles } from "./runtime-particles";
import type { ScriptHostServices } from "./script-host";
import { vec3Arg } from "./script-host-helpers";

interface ParticleParameterDeps {
  particles: RuntimeParticles;
  findActor(actorGuid: string): Actor | undefined;
  emit(command: CommandMessage): void;
  /** One warning per unknown name per session (`particle.unknown_parameter`). */
  warn(message: string): void;
}

type Target = { component: ActorComponent; systemGuid: string };

/** The Particle System a ParticleComponent plays, or null without one. */
export function particleComponentSystemGuid(component: ActorComponent): string | null {
  const variable = component.getVariable("particleSystemGuid");
  const guid = typeof variable === "string" && variable ? variable : component.assetGuid;
  return typeof guid === "string" && guid ? guid : null;
}

/** A ParticleComponent's authored Parameter Overrides by name. */
export function particleComponentOverrides(component: ActorComponent): Record<string, number[]> {
  return normalizeParticleParameterValues(component.getVariable("parameterOverrides"));
}

function targets(actor: Actor | undefined, componentId: string | undefined): Target[] {
  if (!actor || actor.destroyed) return [];
  const found: Target[] = [];
  for (const component of actor.components) {
    if (component.destroyed || component.classId !== "ParticleComponent") continue;
    if (componentId && component.guid !== componentId) continue;
    const systemGuid = particleComponentSystemGuid(component);
    if (systemGuid) found.push({ component, systemGuid });
  }
  return found;
}

/**
 * Get, Set and Reset Particle Parameter: runtime values on an actor's ParticleComponents (one
 * with `componentId`). A value applies only to components whose Particle System declares the
 * name, resized to its type; a name no targeted System declares does nothing and warns once.
 * A reset goes back to the component's override, else the System or emitter default.
 */
export function createParticleParameterBindings(deps: ParticleParameterDeps): Required<Pick<ScriptHostServices,
  "setParticleParameter" | "getParticleParameter" | "resetParticleParameter">> {
  const declaring = (actorGuid: string, name: string, componentId?: string) =>
    targets(deps.findActor(actorGuid), componentId).flatMap((target) => {
      const entry = deps.particles.parameter(target.systemGuid, name);
      return entry ? [{ ...target, entry }] : [];
    });
  const unknown = (actorGuid: string, name: string) => {
    if (!deps.particles.firstUnknownUse(name)) return;
    const actor = deps.findActor(actorGuid);
    deps.warn(`Particle parameter "${name}" is not declared by the Particle System of a Particle component on ${actor?.classId ?? actorGuid}; it is ignored.`);
  };
  return {
    setParticleParameter: (actorGuid, rawName, value, componentId) => {
      const name = String(rawName ?? "").trim();
      const matches = declaring(actorGuid, name, componentId);
      if (!matches.length) {
        unknown(actorGuid, name);
        return false;
      }
      for (const { component, entry } of matches) {
        const resized = resizeParticleParameterValue(value, entry.type);
        deps.particles.setValue(actorGuid, component.guid, name, resized);
        deps.emit({ type: "setParticleParameter", actorGuid, componentId: component.guid, name, value: resized });
      }
      return true;
    },
    getParticleParameter: (actorGuid, rawName, componentId) => {
      const name = String(rawName ?? "").trim();
      const [match] = declaring(actorGuid, name, componentId);
      if (!match) return { found: false, value: [] };
      const value = deps.particles.value(actorGuid, match.component.guid, name)
        ?? particleComponentOverrides(match.component)[name]
        ?? match.entry.defaultValue;
      return { found: true, value: resizeParticleParameterValue(value, match.entry.type) };
    },
    resetParticleParameter: (actorGuid, rawName, componentId) => {
      const name = String(rawName ?? "").trim();
      const matches = declaring(actorGuid, name, componentId);
      if (!matches.length) {
        unknown(actorGuid, name);
        return false;
      }
      for (const { component, entry } of matches) {
        deps.particles.clearValue(actorGuid, component.guid, name);
        const override = particleComponentOverrides(component)[name];
        deps.emit({ type: "setParticleParameter", actorGuid, componentId: component.guid, name,
          value: override ? resizeParticleParameterValue(override, entry.type) : null });
      }
      return true;
    },
  };
}

/** A Float, Vector or Color parameter node value as numbers. */
export function particleParameterArg(kind: string, value: unknown): number[] {
  if (kind === "Float") return [Number(value) || 0];
  const { x, y, z } = vec3Arg(value);
  if (kind === "Vector") return [x, y, z];
  const w = Number((value as { w?: unknown } | null)?.w ?? 1);
  return [x, y, z, Number.isFinite(w) ? w : 1];
}

/** Numbers as a Float, Vector (X, Y, Z) or Color (alpha 1 when missing) node value. */
export function particleParameterResult(kind: string, value: readonly number[]): unknown {
  if (kind === "Float") return value[0] ?? 0;
  const vector = { x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 };
  return kind === "Vector" ? vector : { ...vector, w: value[3] ?? 1 };
}
