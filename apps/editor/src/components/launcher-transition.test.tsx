import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReducedMotion } from "@haptic/editor-kit";
import {
  LauncherTransitionProvider,
  useLauncherTransition,
} from "./launcher-transition";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("__HAPTIC_BUILD_LABEL__", "0.0.1 Development Build");
  // The boot intro index.html paints outside React for the first transition.
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<div id="haptic-intro" class="haptic-loading" role="status"><span class="haptic-intro-status"></span></div>',
  );
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  document.getElementById("haptic-intro")?.remove();
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

/** The project card's status line. */
function status() {
  return document.querySelector(".haptic-splash-status")?.textContent ?? null;
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

function changeReducedMotion(value: boolean) {
  act(() => {
    // What the editor does when Reduce Motion or the device setting changes.
    setReducedMotion(value);
  });
}

/** Ends the boot intro, then shows the project-open card until it starts to fade. */
function openProjectUntilFade(launcher: ReturnType<typeof renderTransition>) {
  act(() => launcher.controls().ready("home"));
  advance(2600);
  act(() => launcher.controls().begin("Test Project"));
  launcher.setRoute("editor");
  act(() => launcher.controls().ready("editor"));
  act(() => launcher.controls().settle());
  advance(2000);
  return screen.getByRole("status");
}

function finishTransition(element: Element, propertyName = "opacity") {
  // jsdom has no TransitionEvent constructor, so preserve the browser payload.
  fireEvent(
    element,
    Object.assign(new Event("transitionend", { bubbles: true }), {
      propertyName,
    }),
  );
}

describe("Launcher Transition", () => {
  it("keeps the minimum loading time but immediately enables a ready route with reduced motion", () => {
    setReducedMotion(true);
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));

    advance(2599);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("does not reveal a reduced-motion route until its content is ready", () => {
    setReducedMotion(true);
    const launcher = renderTransition();
    advance(3000);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    act(() => launcher.controls().ready("home"));
    advance(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("ends the boot intro at once, without a fade, when its minimum time is over", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));

    advance(2599);
    expect(document.getElementById("haptic-intro")).toBeTruthy();
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(1);
    expect(document.getElementById("haptic-intro")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("unlocks the route when the project-open card's opacity fade finishes, ignoring unrelated transition events", () => {
    const launcher = renderTransition();
    const overlay = openProjectUntilFade(launcher);

    finishTransition(overlay.firstElementChild!);
    finishTransition(overlay, "transform");
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    finishTransition(overlay);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("releases the route if the browser never reports the project-open card's fade completion", () => {
    const launcher = renderTransition();
    openProjectUntilFade(launcher);
    advance(649);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    advance(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("enables the visible route when reduced motion is turned on during the project-open card's fade", () => {
    const launcher = renderTransition();
    openProjectUntilFade(launcher);
    advance(100);
    expect(launcher.surface().hasAttribute("inert")).toBe(true);

    changeReducedMotion(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });

  it("keeps the editor readiness hold after a slow project settles with reduced motion", () => {
    setReducedMotion(true);
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

  it("names each step of a Remote New Project, whichever of the editor mounting and the Publish comes first", () => {
    for (const publishFirst of [false, true]) {
      const launcher = renderTransition();
      act(() => launcher.controls().ready("home"));
      advance(2600);
      act(() => launcher.controls().begin("Forest Run", "creating"));
      expect(status()).toBe("Creating project");
      act(() => launcher.controls().setPhase("opening"));
      expect(status()).toBe("Opening project");
      launcher.setRoute("editor");
      if (publishFirst) {
        act(() => launcher.controls().setPhase("source-control"));
        act(() => launcher.controls().ready("editor"));
      } else {
        act(() => launcher.controls().ready("editor"));
        expect(status()).toBe("Preparing editor");
        act(() => launcher.controls().setPhase("source-control"));
      }
      // The editor mounting beneath the card never hides the step still running.
      expect(status()).toBe("Initializing source control");
      act(() => launcher.controls().settle());
      expect(status()).toBe("Ready");
      cleanup();
    }
  });

  it("opens a listed project as Opening project, then Preparing editor, and takes no step once it settled", () => {
    const launcher = renderTransition();
    // No project open is under way: the boot intro keeps its own status, and nothing starts one.
    act(() => launcher.controls().setPhase("creating"));
    expect(document.querySelector(".haptic-intro-status")?.textContent).toBe("Loading application");
    act(() => launcher.controls().ready("home"));
    advance(2600);
    act(() => launcher.controls().setPhase("creating"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
    act(() => launcher.controls().begin("Test Project"));
    expect(status()).toBe("Opening project");
    launcher.setRoute("editor");
    act(() => launcher.controls().ready("editor"));
    expect(status()).toBe("Preparing editor");
    act(() => launcher.controls().settle());
    act(() => launcher.controls().setPhase("source-control"));
    expect(status()).toBe("Ready");
  });

  it("restores the home route when opening a project is cancelled", () => {
    const launcher = renderTransition();
    act(() => launcher.controls().ready("home"));
    advance(2600);

    act(() => launcher.controls().begin("Cancelled Project"));
    expect(launcher.surface().hasAttribute("inert")).toBe(true);
    act(() => launcher.controls().settle());
    expect(screen.queryByRole("status")).toBeNull();
    expect(launcher.surface().hasAttribute("inert")).toBe(false);
  });
});
