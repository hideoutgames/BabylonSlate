import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  createRenderProfileRecorder,
  createRenderProfileRegions,
  profileComponents,
  profileRegion,
  renderProfile,
} from "./render-profile";

afterEach(() => {
  cleanup();
});

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count {count}
    </button>
  );
}

function Label() {
  return <span>Static</span>;
}

describe("editor-edit render profile", () => {
  it("attributes each commit only to the regions that rendered and counts it once", () => {
    const recorder = createRenderProfileRecorder(true);
    const { region, components } = createRenderProfileRegions(recorder.onRender);
    const { counter: CounterPanel, label: LabelPanel } = components("panel:", {
      counter: Counter,
      label: Label,
    });
    render(
      region(
        "route",
        <>
          {region("edited", <CounterPanel />)}
          {region("idle", <LabelPanel />)}
        </>,
      ),
    );
    const mounted = recorder.snapshot();
    expect(mounted.commits).toBe(1);
    expect(mounted.regions.idle).toMatchObject({ commits: 1, mounts: 1, updates: 0 });
    expect(mounted.regions["panel:label"]).toMatchObject({ commits: 1, mounts: 1 });

    recorder.reset();
    fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Count 1" }));

    const edited = recorder.snapshot();
    expect(edited.enabled).toBe(true);
    expect(edited.commits).toBe(2);
    // The sibling region and panel bailed out, so they report nothing.
    expect(Object.keys(edited.regions).sort()).toEqual([
      "edited",
      "panel:counter",
      "route",
    ]);
    for (const id of ["route", "edited", "panel:counter"]) {
      expect(edited.regions[id]).toMatchObject({
        commits: 2,
        mounts: 0,
        updates: 2,
        nestedUpdates: 0,
      });
    }
  });

  it("counts one commit for a region id rendered by several instances", () => {
    const recorder = createRenderProfileRecorder(true);
    const { components } = createRenderProfileRegions(recorder.onRender);
    const { value: ValuePanel } = components<{ value: number }>("panel:", {
      value: ({ value }) => <span>Value {value}</span>,
    });
    function Documents() {
      const [value, setValue] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setValue((current) => current + 1)}>
            Edit
          </button>
          <ValuePanel value={value} />
          <ValuePanel value={value} />
        </>
      );
    }
    render(<Documents />);
    recorder.reset();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const edited = recorder.snapshot();
    expect(screen.getAllByText("Value 1")).toHaveLength(2);
    expect(edited.commits).toBe(1);
    expect(edited.regions["panel:value"]).toMatchObject({ commits: 1, updates: 2 });
  });

  it("mounts no Profilers outside test mode", () => {
    const panels = { counter: Counter };
    expect(profileComponents("panel:", panels)).toBe(panels);
    render(profileRegion("route", <Counter />));
    fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
    expect(renderProfile()).toEqual({ enabled: false, commits: 0, regions: {} });
  });
});
