import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomepageGallery } from "./homepage-gallery";

const projects = Array.from({ length: 24 }, (_, index) => ({
  id: `project-${index + 1}`,
  content: <button>Project {index + 1}</button>,
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function gallery() {
  return screen.getByRole("region", { name: "Projects" });
}

describe("Homepage gallery", () => {
  it("lists every item in one scrollable region without page controls", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    expect(screen.getAllByRole("button", { name: /^Project \d+$/ })).toHaveLength(
      24,
    );
    expect(screen.queryByRole("button", { name: /Page/ })).toBeNull();
    expect(gallery().tabIndex).toBe(0);
  });

  it("shows the empty content when there are no items", () => {
    render(
      <HomepageGallery items={[]} label="Projects" empty={<p>Nothing</p>} />,
    );
    expect(screen.getByText("Nothing")).toBeTruthy();
    expect(gallery().tabIndex).toBe(-1);
  });

  it("marks momentum scrolling until the scroll settles", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    fireEvent.scroll(gallery());
    expect(gallery().getAttribute("data-scrolling")).toBe("true");
    fireEvent(gallery(), new Event("scrollend"));
    expect(gallery().hasAttribute("data-scrolling")).toBe(false);

    fireEvent.scroll(gallery());
    act(() => vi.advanceTimersByTime(200));
    expect(gallery().hasAttribute("data-scrolling")).toBe(false);
  });

  it("keeps a touch-held scroll marked until the finger lifts", () => {
    render(<HomepageGallery items={projects} label="Projects" />);
    fireEvent.touchStart(gallery(), { touches: [{ identifier: 1 }] });
    fireEvent.scroll(gallery());
    act(() => vi.advanceTimersByTime(1000));
    fireEvent(gallery(), new Event("scrollend"));
    expect(gallery().getAttribute("data-scrolling")).toBe("true");

    fireEvent.touchEnd(gallery(), { touches: [] });
    act(() => vi.advanceTimersByTime(200));
    expect(gallery().hasAttribute("data-scrolling")).toBe(false);
  });
});
