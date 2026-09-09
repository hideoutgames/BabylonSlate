import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HomepageGallery } from "./homepage-gallery";

let width = 1200;
let height = 464;
let reducedMotion = false;
const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
const projects = Array.from({ length: 24 }, (_, index) => ({
  id: `project-${index + 1}`,
  content: <button>Project {index + 1}</button>,
}));

beforeEach(() => {
  width = 1200;
  height = 464;
  reducedMotion = false;
  scrollTo.mockReset();
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("homepage-pages") ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("homepage-pages") ? height : 0;
    },
  );
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: reducedMotion && media === "(prefers-reduced-motion: reduce)",
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  // jsdom has no scrolling implementation. Smooth requests deliberately leave
  // scrollLeft unchanged until a native scroll/scrollend is simulated below.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrollTo(options);
      if (options.behavior === "instant") {
        this.scrollLeft = options.left ?? this.scrollLeft;
      }
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

function gallery() {
  return screen.getByRole("region", { name: "Projects" });
}

function scroll(left: number, settled = false) {
  const element = gallery();
  element.scrollLeft = left;
  fireEvent.scroll(element);
  if (settled) fireEvent(element, new Event("scrollend"));
}

function activePage() {
  return gallery().querySelector('[role="group"]:not([inert])');
}

describe("Homepage gallery navigation", () => {
  it("accumulates rapid next/previous requests before smooth scrolling catches up", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));
    expect(
      screen
        .getByRole("button", { name: "Previous Page" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Previous Page" }));

    expect(scrollTo.mock.calls.map(([options]) => options.left)).toEqual([
      1200, 2400, 1200,
    ]);
    expect(screen.getByRole("status").textContent).toBe("01 / 08");
    scroll(1200, true);
    expect(screen.getByRole("status").textContent).toBe("02 / 08");
  });

  it("keeps activation and announcements on the settled page throughout a swipe", () => {
    render(<HomepageGallery items={projects} label="Projects" />);

    scroll(720);
    expect(gallery().getAttribute("data-scrolling")).toBe("true");
    expect(activePage()?.getAttribute("aria-label")).toBe("Page 1 of 8");
    expect(screen.getByRole("status").textContent).toBe("01 / 08");

    scroll(1200, true);
    expect(gallery().getAttribute("data-scrolling")).not.toBe("true");
    expect(activePage()?.getAttribute("aria-label")).toBe("Page 2 of 8");
    expect(screen.getByRole("status").textContent).toBe("02 / 08");
  });

  it("settles when scrolling stops on browsers without a scrollend event", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    fireEvent.touchStart(gallery(), { touches: [{ identifier: 1 }] });
    scroll(1200);
    expect(activePage()?.getAttribute("aria-label")).toBe("Page 1 of 8");

    act(() => vi.advanceTimersByTime(1000));
    expect(activePage()?.getAttribute("aria-label")).toBe("Page 1 of 8");
    expect(gallery().getAttribute("data-scrolling")).toBe("true");
    fireEvent.touchEnd(gallery(), { touches: [] });
    act(() => vi.advanceTimersByTime(1000));

    expect(activePage()?.getAttribute("aria-label")).toBe("Page 2 of 8");
    expect(gallery().getAttribute("data-scrolling")).not.toBe("true");
  });

  it("keeps the current project visible when viewport width changes the page size", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    scroll(2400, true);
    expect(activePage()?.textContent).toContain("Project 7");

    width = 700;
    fireEvent(window, new Event("resize"));

    expect(activePage()?.getAttribute("aria-label")).toBe("Page 4 of 12");
    expect(activePage()?.textContent).toContain("Project 7");
    expect(gallery().scrollLeft).toBe(2100);
  });

  it("keeps the current project visible through layout changes and their delayed scroll events", () => {
    const view = render(<HomepageGallery items={projects} label="Projects" />);
    scroll(2400, true);

    view.rerender(
      <HomepageGallery items={projects} label="Projects" layout="small" />,
    );

    expect(activePage()?.getAttribute("aria-label")).toBe("Page 1 of 3");
    expect(activePage()?.textContent).toContain("Project 7");
    fireEvent.scroll(gallery());
    fireEvent(gallery(), new Event("scrollend"));

    view.rerender(
      <HomepageGallery items={projects} label="Projects" layout="list" />,
    );

    expect(activePage()?.getAttribute("aria-label")).toBe("Page 2 of 4");
    expect(activePage()?.textContent).toContain("Project 7");
    expect(gallery().scrollLeft).toBe(1200);
  });

  it("keeps keyboard navigation immediate with reduced motion and ignores child arrow keys", () => {
    reducedMotion = true;
    render(<HomepageGallery items={projects} label="Projects" />);
    scrollTo.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Project 1" }), {
      key: "ArrowRight",
    });
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.keyDown(gallery(), { key: "ArrowRight" });
    fireEvent.keyDown(gallery(), { key: "ArrowRight" });

    expect(gallery().scrollLeft).toBe(2400);
    expect(activePage()?.getAttribute("aria-label")).toBe("Page 3 of 8");
    expect(gallery().getAttribute("data-scrolling")).not.toBe("true");
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 2400,
      behavior: "instant",
    });
  });
});
