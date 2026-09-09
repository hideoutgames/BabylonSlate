import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppRoutes } from "./app-routes";

const state = vi.hoisted(() => ({ route: "home" }));
vi.mock("./context/document-context", () => ({ useDocuments: () => state }));
vi.mock("./routes/home-route", () => ({ default: () => null }));
vi.mock("./routes/editor-route", () => ({ default: () => null }));
vi.mock("./components/launcher-transition", () => ({
  LauncherTransitionProvider: ({ children }: { children: ReactNode }) =>
    children,
  EditorRouteReady: () => null,
}));

afterEach(() => {
  cleanup();
  state.route = "home";
});

it("reserves three-finger editing suppression for the editor and releases it on return home", async () => {
  const touch = () => {
    const event = new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [0, 1, 2].map((identifier) => ({
        identifier,
        clientX: identifier * 10,
        clientY: 0,
      })) as Touch[],
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const view = render(<AppRoutes />);
  await act(async () => {});
  expect(touch()).toBe(false);
  state.route = "editor";
  view.rerender(<AppRoutes />);
  await act(async () => {});
  expect(touch()).toBe(true);
  state.route = "home";
  view.rerender(<AppRoutes />);
  expect(touch()).toBe(false);
});
