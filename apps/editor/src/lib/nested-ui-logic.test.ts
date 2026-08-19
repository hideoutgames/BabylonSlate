import { describe, expect, it } from "vitest";
import { userInterfaceClassId } from "@babylonslate/core";
import {
  collectNestedUiLogicSources,
  nestedUiSlots,
} from "./nested-ui-logic";

describe("collectNestedUiLogicSources", () => {
  it("walks nested UserInterface widgets and skips cycles", () => {
    const nested = collectNestedUiLogicSources(
      {
        rootId: "canvas",
        widgets: {
          canvas: { id: "canvas", kind: "Canvas", children: ["chip"] },
          chip: {
            id: "chip",
            kind: "UserInterface",
            nestedUiGuid: "chip-guid",
            children: [],
          },
        },
      },
      (guid) => {
        if (guid === "chip-guid") {
          return {
            path: "assets/Chip.ui.babasset",
            payload: {
              rootId: "canvas",
              widgets: {
                canvas: { id: "canvas", kind: "Canvas", children: ["inner"] },
                inner: {
                  id: "inner",
                  kind: "UserInterface",
                  nestedUiGuid: "chip-guid",
                  children: [],
                },
              },
              logic: { nodes: [], edges: [] },
            },
          };
        }
        return null;
      },
    );
    expect(nested).toEqual([
      {
        slotId: "chip",
        guid: "chip-guid",
        path: "assets/Chip.ui.babasset",
        payload: expect.objectContaining({ logic: expect.any(Object) }),
      },
    ]);
    expect(nestedUiSlots(nested)).toEqual([
      { slotId: "chip", classId: userInterfaceClassId("chip-guid") },
    ]);
  });
});
