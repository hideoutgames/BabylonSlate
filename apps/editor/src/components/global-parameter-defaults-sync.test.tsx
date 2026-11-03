import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { GlobalParameterCatalog } from "@haptic/core";
import {
  currentGlobalParameterCatalog,
  globalParameterDefaults,
  setGlobalParameterCatalog,
} from "@haptic/render/global-parameter-values";

const harness = vi.hoisted(() => ({ catalog: {} as GlobalParameterCatalog }));
vi.mock("../lib/global-parameter-catalog", () => ({ useGlobalParameterCatalog: () => harness.catalog }));

const { GlobalParameterDefaultsSync } = await import("./global-parameter-defaults-sync");

afterEach(() => {
  cleanup();
  setGlobalParameterCatalog({});
});

describe("GlobalParameterDefaultsSync", () => {
  it("gives the renderer the project's defaults and every later edit of them", () => {
    harness.catalog = { fx: [{ id: "tint", name: "Sky Tint", type: "color", defaultValue: [1, 1, 1, 1] }] };
    const view = render(<GlobalParameterDefaultsSync />);
    expect(globalParameterDefaults.value("fx", "tint")).toEqual([1, 1, 1, 1]);
    const revision = globalParameterDefaults.revision;
    // An unsaved edit in an open collection changes the catalog the hook returns.
    harness.catalog = { fx: [{ id: "tint", name: "Sky Tint", type: "color", defaultValue: [0, 0.5, 1, 1] }] };
    view.rerender(<GlobalParameterDefaultsSync />);
    expect(globalParameterDefaults.value("fx", "tint")).toEqual([0, 0.5, 1, 1]);
    expect(globalParameterDefaults.revision).toBe(revision + 1);
    expect(currentGlobalParameterCatalog()).toEqual(harness.catalog);
  });
});
