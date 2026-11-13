import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
} from "@haptic/anim-graph";
import { commitAnimGraphVariables } from "./anim-graph-variables";

describe("commitAnimGraphVariables", () => {
  it("syncs Get and Set nodes on the Animation Object, rule and pose graphs", () => {
    const doc = createDefaultAnimGraph();
    doc.variables = [
      { id: "var-speed", name: "Speed", typeId: "float", defaultValue: 0 },
    ];
    doc.animationObject = {
      ...doc.animationObject,
      nodes: [
        ...doc.animationObject.nodes,
        {
          id: "get-speed",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            variableId: "var-speed",
            variableName: "Speed",
            typeId: "float",
            title: "Get Speed",
          },
        },
        {
          id: "set-speed",
          type: "variables.set",
          position: { x: 0, y: 80 },
          data: {
            variableId: "var-speed",
            variableName: "Speed",
            typeId: "float",
            title: "Set Speed",
          },
        },
      ],
    };
    const rule = createDefaultTransitionRuleGraph();
    rule.nodes.push({
      id: "get-speed-rule",
      type: "variables.get",
      position: { x: 0, y: 0 },
      data: {
        variableId: "var-speed",
        variableName: "Speed",
        typeId: "float",
        title: "Get Speed",
      },
    });
    doc.stateMachines[0]!.transitions = [
      {
        id: "idle-to-run",
        fromStateId: "idle",
        toStateId: "idle",
        blendSeconds: 0,
        priority: 0,
        ruleGraph: rule,
      },
    ];

    const getSpeed = (id: string) => ({
      id,
      type: "variables.get",
      position: { x: 0, y: 0 },
      data: { variableId: "var-speed", variableName: "Speed", typeId: "float", title: "Get Speed" },
    });
    const idle = doc.stateMachines[0]!.states[0]!;
    idle.stateGraph = { ...idle.stateGraph, nodes: [...idle.stateGraph.nodes, getSpeed("get-speed-state")] };
    doc.animGraph = { ...doc.animGraph, nodes: [...doc.animGraph.nodes, getSpeed("get-speed-anim")] };

    const next = commitAnimGraphVariables(doc, [
      { id: "var-speed", name: "MoveSpeed", typeId: "int", defaultValue: 0 },
    ]);

    expect(
      next.animationObject.nodes.find((node) => node.id === "get-speed")?.data,
    ).toMatchObject({
      variableName: "MoveSpeed",
      typeId: "int",
      title: "Get MoveSpeed",
    });
    expect(
      next.animationObject.nodes.find((node) => node.id === "set-speed")?.data,
    ).toMatchObject({
      variableName: "MoveSpeed",
      title: "Set MoveSpeed",
    });
    expect(
      next.stateMachines[0]!.transitions[0]?.ruleGraph.nodes.find((node) => node.id === "get-speed-rule")
        ?.data,
    ).toMatchObject({
      variableName: "MoveSpeed",
      title: "Get MoveSpeed",
    });
    for (const graph of [next.stateMachines[0]!.states[0]!.stateGraph, next.animGraph]) {
      expect(graph.nodes.find((node) => node.id.startsWith("get-speed-"))?.data).toMatchObject({
        variableName: "MoveSpeed",
        typeId: "int",
        title: "Get MoveSpeed",
      });
    }
  });
});
