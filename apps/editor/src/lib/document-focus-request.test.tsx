import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { requestDocumentFocus, useDocumentFocusRequest } from "./document-focus-request";

function Shell({ id, active }: { id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDocumentFocusRequest(id, active, ref);
  return <div ref={ref} data-testid={id} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("moves the keyboard into the active document that was asked for", () => {
  render(<><Shell id="graph:a" active /><Shell id="graph:b" active={false} /></>);
  act(() => requestDocumentFocus("graph:a"));
  expect(document.activeElement).toBe(screen.getByTestId("graph:a"));
});

it("holds the request until the document becomes the active tab", () => {
  const view = render(<Shell id="graph:a" active={false} />);
  act(() => requestDocumentFocus("graph:a"));
  expect(document.activeElement).toBe(document.body);
  view.rerender(<Shell id="graph:a" active />);
  expect(document.activeElement).toBe(screen.getByTestId("graph:a"));
});

it("takes the keyboard once, and not for a request nobody claimed in time", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const view = render(<Shell id="graph:a" active={false} />);
  act(() => requestDocumentFocus("graph:a"));
  now.mockReturnValue(10_000);
  view.rerender(<Shell id="graph:a" active />);
  expect(document.activeElement).toBe(document.body);

  act(() => requestDocumentFocus("graph:a"));
  expect(document.activeElement).toBe(screen.getByTestId("graph:a"));
  // Switching away and back later does not pull the keyboard in again.
  act(() => (document.activeElement as HTMLElement).blur());
  view.rerender(<Shell id="graph:a" active={false} />);
  view.rerender(<Shell id="graph:a" active />);
  expect(document.activeElement).toBe(document.body);
});
