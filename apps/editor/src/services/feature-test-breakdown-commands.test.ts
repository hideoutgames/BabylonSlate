import { describe, expect, it } from "vitest";
import { RenderingQualitySession, type QualityGroup } from "@haptic/core";
import { createCommandRegistry, type ConsoleCommandHost } from "@haptic/debugger";
import {
  FEATURE_TEST_BENCHMARK_PROFILES, FEATURE_TEST_BREAKDOWN_BASES, FEATURE_TEST_BREAKDOWN_METHODS, FEATURE_TEST_BREAKDOWN_SCENES,
  featureTestBreakdownPlan, featureTestProfileSteps,
} from "./feature-test-check";

/** Every console line a Benchmark, Breakdown or Profile sends to Play, with where it comes from. */
function measuredCommands(): { source: string; line: string }[] {
  const lines: { source: string; line: string }[] = [];
  for (const profile of FEATURE_TEST_BENCHMARK_PROFILES)
    for (const line of profile.commands) lines.push({ source: `benchmark ${profile.label}`, line });
  // Each method's base, then its plan per scene.
  for (const method of FEATURE_TEST_BREAKDOWN_METHODS) {
    const base = FEATURE_TEST_BREAKDOWN_BASES[method];
    for (const line of base.commands) lines.push({ source: `${method} base`, line });
    for (const scene of FEATURE_TEST_BREAKDOWN_SCENES) {
      const plan = featureTestBreakdownPlan(scene.name, method);
      for (const view of plan.views) {
        for (const line of view.enter ?? []) lines.push({ source: `${method} ${scene.name} enter`, line });
        for (const step of view.steps)
          for (const line of [...step.commands, ...(step.restore ?? [])]) lines.push({ source: `${method} ${scene.name} ${step.label}`, line });
      }
    }
  }
  // A Profile's steps and restores, for each state they toggle back to.
  for (const state of [
    { occlusion: true, framesInFlight: 2, postProcessing: true, captures: true },
    { occlusion: false, framesInFlight: "off", postProcessing: false, captures: false },
    { occlusion: true, framesInFlight: 3, postProcessing: true, captures: true },
  ] as const) {
    for (const step of featureTestProfileSteps(state))
      for (const line of [...step.commands, ...(step.restore ?? [])]) lines.push({ source: `profile ${step.label}`, line });
  }
  return lines;
}

/** A console host whose `quality` is a real session; every other host call succeeds. */
function host(session: RenderingQualitySession): ConsoleCommandHost {
  const succeed = () => ({ success: true, output: "" });
  return new Proxy({} as ConsoleCommandHost, {
    get: (_, key) => key === "quality"
      ? (group?: QualityGroup, choice?: string, value?: string) => session.execute(group, choice, value)
      : succeed,
  });
}

describe("Feature Test measurement commands", () => {
  it("are console commands Play parses and runs, quality settings included", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    const commands = measuredCommands();
    expect(commands.some(({ line }) => line.startsWith("quality postprocessing antialiasing"))).toBe(true);
    expect(commands.some(({ line }) => line === "framesinflight 3")).toBe(true);
    for (const { source, line } of commands) {
      const session = new RenderingQualitySession();
      const result = registry.execute(line, host(session));
      expect(result, `${source}: ${line}`).toMatchObject({ success: true });
    }
  });
});
