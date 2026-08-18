import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CONTENT_BROWSER_ID } from "@babylonslate/core";
import {
  DOCUMENT_IDLE_UNMOUNT_MS,
  MAX_WARM_DOCUMENT_WORKSPACES,
  advanceTestIdleClock,
  createIdleClock,
  selectMountedDocumentIds,
  useDocumentWorkingSet,
} from "./document-working-set";

vi.mock("@babylonslate/vfs", () => ({
  isTestModeEnabled: () => true,
}));

const CB = CONTENT_BROWSER_ID;

function ids(...tabIds: string[]) {
  return tabIds;
}

describe("document working set", () => {
  it("exports the named idle-unmount constants", () => {
    expect(DOCUMENT_IDLE_UNMOUNT_MS).toBe(120_000);
    expect(MAX_WARM_DOCUMENT_WORKSPACES).toBe(3);
  });

  it("always mounts Content Browser and the active tab", () => {
    const mounted = selectMountedDocumentIds({
      tabIds: ids(CB, "graph:A", "scene:S"),
      activeId: "graph:A",
      lastActiveAt: new Map(),
      now: 0,
    });
    expect(mounted).toEqual(new Set([CB, "graph:A"]));
  });

  it("keeps an inactive tab mounted inside the 2-minute grace", () => {
    const mounted = selectMountedDocumentIds({
      tabIds: ids(CB, "scene:S", "graph:A"),
      activeId: "scene:S",
      lastActiveAt: new Map([
        ["scene:S", 10_000],
        ["graph:A", 10_000],
      ]),
      now: 10_000 + DOCUMENT_IDLE_UNMOUNT_MS - 1,
    });
    expect(mounted).toEqual(new Set([CB, "scene:S", "graph:A"]));
  });

  it("unmounts an inactive tab once the 2-minute grace elapses", () => {
    const mounted = selectMountedDocumentIds({
      tabIds: ids(CB, "scene:S", "graph:A"),
      activeId: CB,
      lastActiveAt: new Map([
        ["scene:S", 0],
        ["graph:A", 0],
      ]),
      now: DOCUMENT_IDLE_UNMOUNT_MS,
    });
    expect(mounted).toEqual(new Set([CB]));
  });

  it("caps warm non-CB workspaces at 3 even inside the grace window", () => {
    const lastActiveAt = new Map<string, number>([
      ["graph:1", 1],
      ["graph:2", 2],
      ["graph:3", 3],
      ["graph:4", 4],
      ["graph:5", 5],
    ]);
    const mounted = selectMountedDocumentIds({
      tabIds: ids(CB, "graph:1", "graph:2", "graph:3", "graph:4", "graph:5"),
      activeId: "graph:5",
      lastActiveAt,
      now: 5,
    });
    expect(mounted).toEqual(new Set([CB, "graph:5", "graph:4", "graph:3"]));
    expect([...mounted].filter((id) => id !== CB)).toHaveLength(3);
  });

  it("keeps the three most recently active Class tabs when Content Browser is focused", () => {
    const mounted = selectMountedDocumentIds({
      tabIds: ids(CB, "graph:1", "graph:2", "graph:3", "graph:4", "graph:5"),
      activeId: CB,
      lastActiveAt: new Map([
        ["graph:1", 1],
        ["graph:2", 2],
        ["graph:3", 3],
        ["graph:4", 4],
        ["graph:5", 5],
      ]),
      now: 5,
    });
    expect(mounted).toEqual(new Set([CB, "graph:5", "graph:4", "graph:3"]));
  });
});

describe("createIdleClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes elapsed idle time while paused", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const clock = createIdleClock();
    expect(clock.now()).toBe(1_000_000);
    clock.setPaused(true);
    vi.setSystemTime(1_000_000 + DOCUMENT_IDLE_UNMOUNT_MS * 2);
    expect(clock.now()).toBe(1_000_000);
    clock.setPaused(false);
    expect(clock.now()).toBe(1_000_000);
    vi.setSystemTime(1_000_000 + DOCUMENT_IDLE_UNMOUNT_MS * 2 + 50);
    expect(clock.now()).toBe(1_000_000 + 50);
  });

  it("advances idle time without waiting on the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const clock = createIdleClock();
    clock.advance(DOCUMENT_IDLE_UNMOUNT_MS);
    expect(clock.now()).toBe(1_000_000 + DOCUMENT_IDLE_UNMOUNT_MS);
  });
});

function MountedProbe({
  tabIds,
  activeId,
}: {
  tabIds: string[];
  activeId: string;
}) {
  const mounted = useDocumentWorkingSet(tabIds, activeId);
  return <div data-testid="mounted">{[...mounted].sort().join(",")}</div>;
}

describe("useDocumentWorkingSet", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("does not remount a Class tab when returning to Scene inside two minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tabIds = [CB, "scene:S", "graph:A"];
    const { rerender } = render(
      <MountedProbe tabIds={tabIds} activeId="scene:S" />,
    );
    rerender(<MountedProbe tabIds={tabIds} activeId="graph:A" />);
    rerender(<MountedProbe tabIds={tabIds} activeId="scene:S" />);
    expect(screen.getByTestId("mounted").textContent).toContain("graph:A");
  });

  it("unmounts inactive workspaces after two minutes on Content Browser", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tabIds = [CB, "scene:S", "graph:A"];
    const { rerender } = render(
      <MountedProbe tabIds={tabIds} activeId="scene:S" />,
    );
    rerender(<MountedProbe tabIds={tabIds} activeId="graph:A" />);
    rerender(<MountedProbe tabIds={tabIds} activeId={CB} />);
    expect(screen.getByTestId("mounted").textContent).toContain("graph:A");
    act(() => {
      vi.advanceTimersByTime(DOCUMENT_IDLE_UNMOUNT_MS);
    });
    expect(screen.getByTestId("mounted").textContent?.split(",").sort()).toEqual(
      [CB].sort(),
    );
  });

  it("caps five Class tabs at three non-CB mounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tabIds = [CB, "graph:1", "graph:2", "graph:3", "graph:4", "graph:5"];
    const { rerender } = render(
      <MountedProbe tabIds={tabIds} activeId="graph:1" />,
    );
    for (const id of ["graph:2", "graph:3", "graph:4", "graph:5"]) {
      vi.setSystemTime(Number(id.slice(-1)));
      rerender(<MountedProbe tabIds={tabIds} activeId={id} />);
    }
    const mounted = screen.getByTestId("mounted").textContent?.split(",") ?? [];
    expect(mounted.filter((id) => id !== CB).sort()).toEqual(
      ["graph:3", "graph:4", "graph:5"].sort(),
    );
  });

  it("does not expire grace while the app is backgrounded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tabIds = [CB, "graph:A"];
    const { rerender } = render(
      <MountedProbe tabIds={tabIds} activeId="graph:A" />,
    );
    rerender(<MountedProbe tabIds={tabIds} activeId={CB} />);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(DOCUMENT_IDLE_UNMOUNT_MS * 2);
    });
    expect(screen.getByTestId("mounted").textContent).toContain("graph:A");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByTestId("mounted").textContent).toContain("graph:A");
    act(() => {
      vi.advanceTimersByTime(DOCUMENT_IDLE_UNMOUNT_MS);
    });
    expect(screen.getByTestId("mounted").textContent).not.toContain("graph:A");
  });

  it("advances idle time from the Playwright hatch without waiting on the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tabIds = [CB, "graph:A"];
    const { rerender } = render(
      <MountedProbe tabIds={tabIds} activeId="graph:A" />,
    );
    rerender(<MountedProbe tabIds={tabIds} activeId={CB} />);
    expect(screen.getByTestId("mounted").textContent).toContain("graph:A");
    act(() => {
      advanceTestIdleClock(DOCUMENT_IDLE_UNMOUNT_MS);
    });
    expect(screen.getByTestId("mounted").textContent).not.toContain("graph:A");
  });
});
