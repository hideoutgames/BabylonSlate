import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mergeEngineTypeSchemas } from "@babylonslate/scripting";
import type { useDataCatalog } from "../lib/use-data-catalog";
import { DataValueEditor } from "./data-value-editor";

afterEach(cleanup);

it("stops mutually recursive Definition branches without suppressing editable sibling values", () => {
  const schemas = mergeEngineTypeSchemas({ dataDefinitions: {
    a: { name: "A", fields: [
      { id: "first", name: "First", typeId: "struct", typeClassId: "b" },
      { id: "second", name: "Second", typeId: "struct", typeClassId: "b" },
    ] },
    b: { name: "B", fields: [
      { id: "amount", name: "Amount", typeId: "float" },
      { id: "loop", name: "Loop", typeId: "struct", typeClassId: "a" },
    ] },
  } });
  const catalog: ReturnType<typeof useDataCatalog> = {
    assets: [], byGuid: new Map(), schemas, enumMembers: {}, pickerAssets: [], propertyAssets: [], classEntries: [],
    types: { structures: [], enums: [], dataDefinitions: [] },
  };
  render(<DataValueEditor field={{ name: "Root", typeId: "struct", typeClassId: "a" }}
    value={{ First: { Amount: 1 }, Second: { Amount: 2 } }} defaultValue={{}}
    onChange={() => undefined} label="Root" path="root" disabled={false} catalog={catalog} issues={[]} />);
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect((screen.getByRole("textbox", { name: "Root First Amount", exact: true }) as HTMLInputElement).value).toBe("1");
  expect((screen.getByRole("textbox", { name: "Root Second Amount", exact: true }) as HTMLInputElement).value).toBe("2");
});
