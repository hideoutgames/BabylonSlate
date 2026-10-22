import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { AppRoutes } from "./app-routes";

const documentState = vi.hoisted(() => ({ route: "home" as "home" | "editor" }));

vi.mock("./context/document-context", async () =>
  (await import("./testing/document-context-mock")).documentContextMock(() => documentState),
);
// A rejected dynamic import, as when the route chunk answers with a transient 503.
// This is its own file because React.lazy keeps the first result of each import.
vi.mock("./routes/home-route", () => {
  throw new Error("route chunk unavailable");
});
vi.mock("./routes/editor-route", () => {
  throw new Error("route chunk unavailable");
});

beforeEach(() => {
  vi.stubGlobal("__HAPTIC_BUILD_LABEL__", "0.0.1 Development build");
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  documentState.route = "home";
});

describe("route chunk that fails to load", () => {
  it.each(["home", "editor"] as const)(
    "shows a Reload action on the %s route instead of a blank screen",
    async (route) => {
      const reload = vi.fn();
      vi.stubGlobal("location", { ...window.location, search: "", reload });
      documentState.route = route;
      render(
        <TooltipProvider>
          <AppRoutes />
        </TooltipProvider>,
      );
      const button = await screen.findByRole("button", { name: "Reload" });
      // The launcher splash would cover the route and disable its Reload action.
      expect(document.querySelector(".slate-loading")).toBeNull();
      fireEvent.click(button);
      expect(reload).toHaveBeenCalledOnce();
    },
  );
});
