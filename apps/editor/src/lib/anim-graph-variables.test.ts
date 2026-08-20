import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
} from "@babylonslate/anim-graph";
import { commitAnimGraphVariables } from "./anim-graph-variables";

describe("commitAnimGraphVariables", () => {
  it("syncs Get and Set nodes on the Animation Object and To State graphs", () => {
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
    doc.transitions = [
      {
        id: "idle-to-run",
        fromStateId: "idle",
        toStateId: "idle",
        blendSeconds: 0,
        priority: 0,
        ruleGraph: rule,
      },
    ];

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
      next.transitions[0]?.ruleGraph.nodes.find((node) => node.id === "get-speed-rule")
        ?.data,
    ).toMatchObject({
      variableName: "MoveSpeed",
      title: "Get MoveSpeed",
    });
  });
});
