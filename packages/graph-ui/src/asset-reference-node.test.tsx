import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import { assetReferenceNodeTypes } from "./asset-reference-node";

afterEach(cleanup);

it("renders asset identities and missing references in a selectable, immutable graph", async () => {
  const onChange = vi.fn();
  const { getByTestId, queryByTestId, getByText } = render(
    <GraphEditor
      readOnly
      focusedNodeId="texture"
      nodeTypes={assetReferenceNodeTypes}
      onChange={onChange}
      initialGraph={{
        nodes: [
          { id: "texture", type: "asset-reference", position: { x: 0, y: 0 }, data: { title: "Stone", assetType: "Texture", path: "assets/Stone.babasset" } },
          { id: "missing", type: "asset-reference", position: { x: 280, y: 0 }, data: { title: "missing", missing: true } },
        ],
        edges: [{ id: "uses", source: "texture", target: "missing", sourceHandle: "uses", targetHandle: "used-by" }],
      }}
    />,
  );
  const texture = getByTestId("asset-reference-node-texture");
  await waitFor(() => expect(texture.getAttribute("data-selected")).toBe("true"));
  expect(texture.textContent).toContain("Stone");
  expect(texture.querySelector("svg")?.getAttribute("width")).toBe("40");
  expect(texture.title).toContain("assets/Stone.babasset");
  expect(getByText("Missing Asset")).toBeTruthy();
  expect(queryByTestId("graph-add-node")).toBeNull();
  const missing = getByTestId("asset-reference-node-missing");
  fireEvent.click(missing);
  await waitFor(() => expect(missing.getAttribute("data-selected")).toBe("true"));
  fireEvent.keyDown(missing, { key: "Delete" });
  expect(getByTestId("asset-reference-node-missing")).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});
