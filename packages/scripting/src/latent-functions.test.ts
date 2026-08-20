import { describe, expect, it } from "vitest";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, FLOAT } from "./types";
import {
  collectLatentFunctions,
  isLatentFunctionKey,
  latentFunctionKey,
  latentSourcesFromSerializedGraph,
} from "./latent-functions";
import type { SerializedGraph } from "@babylonslate/core";

function registryWithLatentCatalog(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register({
    id: "timers.delay",
    title: "Delay",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("duration", "duration", "in", FLOAT),
    ],
    codegen: () => {},
  });
  registry.register({
    id: "debug.executeJavaScript",
    title: "Execute JavaScript",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: () => {},
  });
  registry.register({
    id: "functions.call",
    title: "Call",
    category: "functions",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: () => {},
  });
  registry.register({
    id: "debug.log",
    title: "Log",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: () => {},
  });
  return registry;
}

describe("collectLatentFunctions", () => {
  it("marks a Function that contains Delay", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Hero",
          functionName: "Wait",
          nodes: [{ typeId: "timers.delay", properties: {} }],
        },
      ],
      registry,
    );
    expect(latent.has(latentFunctionKey("Hero", "Wait"))).toBe(true);
    expect(isLatentFunctionKey("Hero", "Wait", latent)).toBe(true);
  });

  it("does not mark a Function with only immediate nodes", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Hero",
          functionName: "Jump",
          nodes: [{ typeId: "debug.log", properties: {} }],
        },
      ],
      registry,
    );
    expect(latent.size).toBe(0);
    expect(isLatentFunctionKey("Hero", "Jump", latent)).toBe(false);
  });

  it("marks a Function that contains async ExecuteJavaScript", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Hero",
          functionName: "Fetch",
          nodes: [
            {
              typeId: "debug.executeJavaScript",
              properties: { async: true },
            },
          ],
        },
      ],
      registry,
    );
    expect(isLatentFunctionKey("Hero", "Fetch", latent)).toBe(true);
  });

  it("does not mark ExecuteJavaScript without async", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Hero",
          functionName: "Compute",
          nodes: [
            {
              typeId: "debug.executeJavaScript",
              properties: { async: false, body: "x = 1;" },
            },
          ],
        },
      ],
      registry,
    );
    expect(isLatentFunctionKey("Hero", "Compute", latent)).toBe(false);
  });

  it("propagates latency through nested Call Function", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Hero",
          functionName: "Wait",
          nodes: [{ typeId: "timers.delay", properties: {} }],
        },
        {
          classId: "Hero",
          functionName: "WaitThenJump",
          nodes: [
            {
              typeId: "functions.call",
              properties: { classId: "Hero", functionName: "Wait" },
            },
          ],
        },
      ],
      registry,
    );
    expect(isLatentFunctionKey("Hero", "Wait", latent)).toBe(true);
    expect(isLatentFunctionKey("Hero", "WaitThenJump", latent)).toBe(true);
  });

  it("walks parentClassId when the Call names a child class", () => {
    const registry = registryWithLatentCatalog();
    const latent = collectLatentFunctions(
      [
        {
          classId: "Actor",
          functionName: "Wait",
          nodes: [{ typeId: "timers.delay", properties: {} }],
        },
      ],
      registry,
      (classId) => (classId === "Hero" ? "Actor" : null),
    );
    expect(isLatentFunctionKey("Hero", "Wait", latent, (id) =>
      id === "Hero" ? "Actor" : null,
    )).toBe(true);
  });

  it("uses the same ident as Call codegen for odd function names", () => {
    expect(latentFunctionKey("Hero", "2 Jump!")).toBe("Hero:_2_Jump_");
  });
});

describe("latentSourcesFromSerializedGraph", () => {
  it("maps function members to their functionGraphs nodes", () => {
    const graph: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "fn-1", kind: "function", name: "Wait" },
        { id: "fn-2", kind: "function", name: "Jump" },
      ],
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "delay",
              type: "timers.delay",
              position: { x: 0, y: 0 },
              data: { duration: 0.25 },
            },
          ],
          edges: [],
        },
      },
    };
    const sources = latentSourcesFromSerializedGraph("Hero", graph);
    expect(sources).toEqual([
      {
        classId: "Hero",
        functionName: "Wait",
        nodes: [{ typeId: "timers.delay", properties: { duration: 0.25 } }],
      },
      {
        classId: "Hero",
        functionName: "Jump",
        nodes: [],
      },
    ]);
  });
});
