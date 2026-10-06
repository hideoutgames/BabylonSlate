import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { SerializedGraph } from "@babylonslate/core";
import { SceneLayerSwitcherFields } from "./scene-layer-switcher-fields";

const documents = vi.hoisted(() => {
  const assets = [
    { path: "assets/Base.class.babasset", header: { guid: "base", name: "Base", type: "Class", parentClass: "SceneLayerActor" } },
    { path: "assets/Screen.class.babasset", header: { guid: "screen", name: "Screen", type: "Class", parentClass: "Base" } },
    { path: "assets/WorldActor.class.babasset", header: { guid: "world", name: "WorldActor", type: "Class", parentClass: "Actor" } },
  ];
  return { assetRegistry: { list: () => assets }, registryEpoch: 0, openDocuments: [], loadGraphDocument: vi.fn(async (path: string): Promise<SerializedGraph> => ({ nodes: [], edges: [], members: path.endsWith("Base.class.babasset") ? [{ id: "title", kind: "variable", name: "Title", typeId: "string", defaultValue: "Inherited Title" }] : [] })) };
});
vi.mock("../context/document-context", () => ({ useDocuments: () => documents }));
afterEach(cleanup);

describe("SceneLayerSwitcherFields", () => {
  it("keeps class-only entries and edits inherited defaults without losing other entries", async () => {
    let latest: Record<string, unknown> = {};
    function Controlled() {
      const [properties, setProperties] = useState<Record<string, unknown>>({ initialIndex: 0, sceneLayerActors: ["Screen", { classId: "SceneLayerActor", defaults: {} }] });
      return <SceneLayerSwitcherFields properties={properties} onChange={value => { latest = value; setProperties(value); }} />;
    }
    render(<Controlled />);
    expect(screen.getAllByRole("button", { name: "Defaults" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Defaults" })[0]!);
    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(title).toHaveProperty("value", "Inherited Title");
    fireEvent.change(title, { target: { value: "Inventory" } });
    fireEvent.blur(title);
    await waitFor(() => expect(latest.sceneLayerActors).toEqual([{ classId: "Screen", defaults: { Title: "Inventory" } }, { classId: "SceneLayerActor", defaults: {} }]));
    fireEvent.click(screen.getByRole("button", { name: "Add Scene Layer Actor" }));
    expect(await screen.findByRole("option", { name: /Screen/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /WorldActor/ })).toBeNull();
  });
});
