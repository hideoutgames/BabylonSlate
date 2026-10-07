import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  filterSearchItems,
  groupSearchItems,
  SearchDialog,
} from "./search-dialog";
import { AssetPicker } from "./asset-picker";
import { AssetCreateProvider, type AssetCreateApi } from "./asset-create-context";

const LIST_BODY = '[data-testid="picker-body"]';

function stubScrollViewportHeight(height: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      const el = this as HTMLElement;
      if (
        el.matches?.(LIST_BODY) ||
        el.getAttribute?.("data-testid") === "picker-body"
      ) {
        return height;
      }
      return descriptor?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  };
}

const items = [
  { id: "a", label: "Alpha", description: "first" },
  { id: "b", label: "Beta", description: "second" },
];

describe("filterSearchItems", () => {
  it("returns everything for an empty query", () => {
    expect(filterSearchItems(items, "  ")).toHaveLength(2);
  });

  it("matches label, description and group case-insensitively", () => {
    expect(filterSearchItems(items, "SECOND").map((item) => item.id)).toEqual([
      "b",
    ]);
    expect(filterSearchItems(items, "alp").map((item) => item.id)).toEqual([
      "a",
    ]);
  });

  it("keeps pinned items for any query, before the matches", () => {
    const withPinned = [
      { id: "create", label: "Create New Material", pinned: true },
      ...items,
    ];
    expect(filterSearchItems(withPinned, "").map((item) => item.id)).toEqual([
      "create",
      "a",
      "b",
    ]);
    expect(
      filterSearchItems(withPinned, "beta").map((item) => item.id),
    ).toEqual(["create", "b"]);
    expect(
      filterSearchItems(withPinned, "zeta").map((item) => item.id),
    ).toEqual(["create"]);
  });
});

describe("groupSearchItems", () => {
  it("keeps consecutive items with the same group in one section", () => {
    expect(
      groupSearchItems([
        { id: "a", label: "A", group: "Letters" },
        { id: "w", label: "W", group: "Letters" },
        { id: "1", label: "1", group: "Digits" },
      ]),
    ).toEqual([
      {
        group: "Letters",
        items: [
          { id: "a", label: "A", group: "Letters" },
          { id: "w", label: "W", group: "Letters" },
        ],
      },
      {
        group: "Digits",
        items: [{ id: "1", label: "1", group: "Digits" }],
      },
    ]);
  });
});

describe("SearchDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("selects a filtered result using arrows and Enter without moving focus out of search", () => {
    const onSelect = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Pick"
        items={items}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );
    const query = screen.getByTestId("picker-query");
    query.focus();
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "ArrowDown" });
    expect(document.activeElement).toBe(query);
    fireEvent.change(query, { target: { value: "Alpha" } });
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("a", "Alpha");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("enters the list on an unpinned row unless only pinned rows are listed", () => {
    const onSelect = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Pick"
        items={[
          { id: "create", label: "Create New Material", pinned: true, keepOpen: true },
          ...items,
        ]}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );
    const query = screen.getByTestId("picker-query");
    query.focus();
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("a", "");

    // Still reachable: one step up from the first unpinned row.
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "ArrowUp" });
    fireEvent.keyDown(query, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("create", "");

    fireEvent.change(query, { target: { value: "Gamma" } });
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("create", "Gamma");
  });

  it("keeps a keyboard-active result mounted beyond the virtual list's first page", () => {
    const restore = stubScrollViewportHeight(132);
    try {
      const onSelect = vi.fn();
      render(
        <SearchDialog
          open
          onOpenChange={() => {}}
          title="Pick"
          items={Array.from({ length: 100 }, (_, index) => ({
            id: `item-${index}`,
            label: `Item ${index}`,
          }))}
          onSelect={onSelect}
          data-testid="picker"
        />,
      );
      const body = screen.getByTestId("picker-body");
      fireEvent.keyDown(body, { key: "End" });
      const active = document.getElementById(
        body.getAttribute("aria-activedescendant")!,
      );
      expect(active?.textContent).toContain("Item 99");
      expect(body.scrollTop).toBeGreaterThan(0);
      fireEvent.keyDown(body, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("item-99", "");
    } finally {
      restore();
    }
  });

  it("filters rows as the query changes and reports the selection", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={onOpenChange}
        title="Add Component"
        items={items}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );

    fireEvent.change(screen.getByTestId("picker-query"), {
      target: { value: "beta" },
    });
    expect(screen.queryByTestId("search-item-a")).toBeNull();

    screen.getByTestId("search-item-b").click();
    expect(onSelect).toHaveBeenCalledWith("b", "beta");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("navigates results from search and commits only a matching option", () => {
    const onSelect = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Pick"
        items={items}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );
    const input = screen.getByTestId("picker-query");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByTestId("search-item-b").getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("b", "");
    onSelect.mockClear();
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("commits a focused option with Enter or Space", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={onOpenChange}
        title="Pick Asset"
        items={items}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );
    const row = screen.getByTestId("search-item-a");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("a", "");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onSelect.mockClear();
    onOpenChange.mockClear();
    fireEvent.keyDown(screen.getByTestId("search-item-b"), { key: " " });
    expect(onSelect).toHaveBeenCalledWith("b", "");
  });

  it("shows the empty label when nothing matches", () => {
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Add Component"
        items={items}
        emptyLabel="No matches"
        onSelect={() => {}}
        data-testid="picker"
      />,
    );
    fireEvent.change(screen.getByTestId("picker-query"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("mounts every picker row when the list viewport height is 0", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      label: `Item ${i}`,
    }));
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Pick"
        items={many}
        onSelect={() => {}}
        data-testid="picker"
      />,
    );
    expect(screen.getAllByTestId(/^search-item-/)).toHaveLength(80);
  });

  it("windows a large picker list and search still finds the last item", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `n${i}`,
      label: `Item ${i}`,
    }));
    const restore = stubScrollViewportHeight(440);
    try {
      const { getByTestId, queryByTestId, getByPlaceholderText } = render(
        <SearchDialog
          open
          onOpenChange={() => {}}
          title="Pick"
          items={many}
          onSelect={() => {}}
          data-testid="picker"
        />,
      );
      const mounted = document.querySelectorAll(
        '[data-testid^="search-item-"]',
      );
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(40);
      expect(queryByTestId("search-item-n0")).toBeTruthy();
      expect(queryByTestId("search-item-n999")).toBeNull();

      fireEvent.change(getByPlaceholderText("Search"), {
        target: { value: "Item 999" },
      });
      expect(getByTestId("search-item-n999")).toBeTruthy();
      expect(queryByTestId("search-item-n0")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("AssetPicker", () => {
  afterEach(() => {
    cleanup();
  });

  const assets = [
    { guid: "g1", name: "Rock", type: "Mesh", path: "assets/rock" },
    { guid: "g2", name: "Grass", type: "Texture", path: "assets/grass" },
  ];

  it("restricts the list to allowed types and can clear the reference", () => {
    const onPick = vi.fn();
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={onPick}
      />,
    );

    expect(screen.queryByTestId("search-item-g1")).toBeNull();
    expect(screen.getByTestId("search-item-g2")).toBeTruthy();

    screen.getByTestId("search-item-__none__").click();
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("passes the picked guid through", () => {
    const onPick = vi.fn();
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowNone={false}
        onPick={onPick}
      />,
    );
    screen.getByTestId("search-item-g1").click();
    expect(onPick).toHaveBeenCalledWith("g1");
  });

  it("shows the asset type and path so identical names can be distinguished", () => {
    const onPick = vi.fn();
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={[
          {
            guid: "g1",
            name: "main.scene",
            type: "Scene",
            path: "assets/main.scene.babasset",
          },
          {
            guid: "g2",
            name: "main.scene",
            type: "Scene",
            path: "assets/levels/main.scene.babasset",
          },
        ]}
        allowNone={false}
        onPick={onPick}
      />,
    );
    const row = screen.getByTestId("search-item-g1");
    expect(within(row).getByText("main")).toBeTruthy();
    expect(row.textContent).toContain("Scene");
    expect(row.textContent).toContain("assets/main.scene.babasset");
    expect(
      row.querySelector("[data-type-family]")?.getAttribute("data-type-family"),
    ).toBe("scene");
    const otherRow = screen.getByTestId("search-item-g2");
    expect(within(otherRow).getByText("main")).toBeTruthy();
    expect(otherRow.textContent).toContain("Scene · assets/levels/main.scene.babasset");
    expect(otherRow.title).toBe("main · assets/levels/main.scene.babasset");
    fireEvent.click(otherRow);
    expect(onPick).toHaveBeenCalledWith("g2");
  });

  it("still matches a search query against the asset path", () => {
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowNone={false}
        onPick={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("asset-picker-query"), {
      target: { value: "assets/rock" },
    });
    expect(screen.getByTestId("search-item-g1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-g2")).toBeNull();
  });
});

describe("AssetPicker Create New rows", () => {
  afterEach(() => {
    cleanup();
  });

  const assets = [
    { guid: "m1", name: "Stone", type: "Material", path: "assets/Stone" },
    { guid: "a1", name: "Wind", type: "Audio", path: "assets/Wind" },
  ];

  function createApi(overrides: Partial<AssetCreateApi> = {}): AssetCreateApi {
    return {
      canCreate: (type) => type === "Material" || type === "RenderTarget",
      typeLabel: (type) => (type === "RenderTarget" ? "Render Target" : type),
      createAsset: vi.fn(async () => "new-guid"),
      ...overrides,
    };
  }

  it("offers rows only for creatable allowed types under a provider", () => {
    const api = createApi();
    const view = render(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          assets={assets}
          allowedTypes={["Material", "RenderTarget", "Audio"]}
          onPick={() => {}}
        />
      </AssetCreateProvider>,
    );
    expect(
      screen.getByTestId("search-item-__create__RenderTarget").textContent,
    ).toContain("Create New Render Target");
    expect(screen.getByTestId("search-item-__create__Material")).toBeTruthy();
    expect(screen.queryByTestId("search-item-__create__Audio")).toBeNull();

    view.rerender(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          assets={assets}
          allowedTypes={["Audio"]}
          onPick={() => {}}
        />
      </AssetCreateProvider>,
    );
    expect(screen.getByTestId("search-item-a1")).toBeTruthy();
    expect(screen.queryByTestId(/search-item-__create__/)).toBeNull();

    view.rerender(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowedTypes={["Material"]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("search-item-m1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-__create__Material")).toBeNull();
  });

  it("narrows create rows to createTypes while still listing every allowed type", () => {
    const api = createApi({
      canCreate: (type) => type === "Material" || type === "MaterialInstance",
    });
    render(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          assets={[
            ...assets,
            { guid: "i1", name: "Stone Wet", type: "MaterialInstance", path: "assets/Stone Wet" },
          ]}
          allowedTypes={["Material", "MaterialInstance"]}
          createTypes={["Material"]}
          onPick={() => {}}
        />
      </AssetCreateProvider>,
    );
    expect(screen.getByTestId("search-item-i1")).toBeTruthy();
    expect(screen.getByTestId("search-item-__create__Material")).toBeTruthy();
    expect(screen.queryByTestId("search-item-__create__MaterialInstance")).toBeNull();
  });

  it("names the asset after the search text, then picks it and closes", async () => {
    const api = createApi();
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={onOpenChange}
          assets={assets}
          allowedTypes={["Material"]}
          createOptions={{ materialDomain: "particle" }}
          onPick={onPick}
        />
      </AssetCreateProvider>,
    );
    fireEvent.change(screen.getByTestId("asset-picker-query"), {
      target: { value: "  Lava Glow " },
    });
    expect(screen.queryByTestId("search-item-m1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-__create__Material"));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("new-guid"));
    expect(api.createAsset).toHaveBeenCalledTimes(1);
    expect(api.createAsset).toHaveBeenCalledWith({
      type: "Material",
      name: "Lava Glow",
      materialDomain: "particle",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks the matching asset with type, ArrowDown, Enter instead of creating", () => {
    const api = createApi();
    const onPick = vi.fn();
    render(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          assets={assets}
          allowedTypes={["Material"]}
          onPick={onPick}
        />
      </AssetCreateProvider>,
    );
    const query = screen.getByTestId("asset-picker-query");
    query.focus();
    fireEvent.change(query, { target: { value: "Stone" } });
    fireEvent.keyDown(query, { key: "ArrowDown" });
    fireEvent.keyDown(query, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith("m1");
    expect(api.createAsset).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the error when creation fails", async () => {
    const api = createApi({
      createAsset: vi.fn(async () => {
        throw new Error("Project storage unavailable");
      }),
    });
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AssetCreateProvider value={api}>
        <AssetPicker
          open
          onOpenChange={onOpenChange}
          assets={assets}
          allowedTypes={["Material"]}
          onPick={onPick}
        />
      </AssetCreateProvider>,
    );
    fireEvent.click(screen.getByTestId("search-item-__create__Material"));

    expect(
      (await screen.findByTestId("asset-picker-error")).textContent,
    ).toContain("Project storage unavailable");
    expect(api.createAsset).toHaveBeenCalledWith({ type: "Material" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("search-item-m1"));
    expect(onPick).toHaveBeenCalledWith("m1");
  });

  it("drops the pick when the dialog closes before creation finishes", async () => {
    let finish: (guid: string) => void = () => {};
    const api = createApi({
      createAsset: vi.fn(
        () => new Promise<string>((resolve) => (finish = resolve)),
      ),
    });
    const onPick = vi.fn();
    const picker = (open: boolean) => (
      <AssetCreateProvider value={api}>
        <AssetPicker
          open={open}
          onOpenChange={() => {}}
          assets={assets}
          allowedTypes={["Material"]}
          onPick={onPick}
        />
      </AssetCreateProvider>
    );
    const view = render(picker(true));
    fireEvent.click(screen.getByTestId("search-item-__create__Material"));
    fireEvent.click(screen.getByTestId("search-item-m1"));
    expect(onPick).not.toHaveBeenCalled();
    view.rerender(picker(false));
    await act(async () => {
      finish("late-guid");
    });
    view.rerender(picker(true));
    fireEvent.click(screen.getByTestId("search-item-m1"));
    expect(onPick.mock.calls).toEqual([["m1"]]);
  });
});
