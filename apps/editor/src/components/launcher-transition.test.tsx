import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LauncherTransitionProvider,
  useLauncherTransition,
} from "./launcher-transition";

let reducedMotion = false;
let motionQuery: MediaQueryList;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("__BABYLONSLATE_BUILD_LABEL__", "0.0.1 Development Build");
  reducedMotion = false;
  motionQuery = Object.assign(new EventTarget(), {
    get matches() {
      return reducedMotion;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList;
  Object.defineProperty(motionQuery, "matches", {
    get: () => reducedMotion,
  });
  vi.stubGlobal("matchMedia", (query: string) =>
    query === motionQuery.media
      ? motionQuery
      : {
          matches: false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderTransition(route = "home") {
  let controls!: ReturnType<typeof useLauncherTransition>;
  function RouteContent() {
    controls = useLauncherTransition();
    return <button>Route Action</button>;
  }
  const tree = (nextRoute: string) => (
    <LauncherTransitionProvider route={nextRoute}>
      <RouteContent />
    </LauncherTransitionProvider>
  );
  const view = render(tree(route));
  return {
    controls: () => controls,
    surface: () => screen.getByRole("button").parentElement!,
    setRoute: (nextRoute: string) => view.rerender(tree(nextRoute)),
  };
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

function changeReducedMotion(value: boolean) {
  act(() => {
    reducedMotion = value;
    motionQuery.dispatchEvent(new Event("change"));
  });
}

describe("Launcher Transition", () => {
  it("keeps the minimum loading time but immediately enables a ready route with reduced motion", () => {
    reducedMotion = true;
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));

    advance(1999);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("does not reveal a reduced-motion route until its content is ready", () => {
    reducedMotion = true;
    const launcher = renderTransition();
    advance(2500);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    act(() => launcher.controls().ready("home"));
    advance(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("unlocks the route when its opacity fade finishes, ignoring unrelated transition events", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));
    const overlay = screen.getByRole("status");

    fireEvent.transitionEnd(overlay, { propertyName: "opacity" });
    expect(launcher.surface().hasAttribute("inert")).toBe(true);
    advance(2000);
    fireEvent.transitionEnd(overlay.querySelector("section")!, {
      propertyName: "opacity",
    });
    fireEvent.transitionEnd(overlay, { propertyName: "transform" });
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(300);
    fireEvent.transitionEnd(overlay, { propertyName: "opacity" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("releases the route if the browser never reports fade completion", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));
    advance(2000);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(650);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("enables the visible route when reduced motion is turned on during its fade", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));
    advance(2000);
    advance(100);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    changeReducedMotion(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("keeps the editor readiness hold after a slow project settles with reduced motion", () => {
    reducedMotion = true;
    const launcher = renderTransition("editor");
    act(() => launcher.controls().begin("Test Project"));
    advance(2200);
    act(() => launcher.controls().ready("editor"));
    advance(700);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    act(() => launcher.controls().settle());
    advance(599);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);
    advance(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("restores the home route when opening a project is cancelled", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));
    advance(2000);
    advance(650);

    act(() => launcher.controls().begin("Cancelled Project"));
    expect(launcher.surface().hasAttribute("inert")).toBe(true);
    act(() => launcher.controls().settle());
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });
});
