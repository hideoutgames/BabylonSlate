import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LockBadge, StatusMarker, type SourceControlStatus } from "./source-control-markers";

afterEach(cleanup);

/** The glyph a marker draws: Lucide's icon name, or its text. */
function glyph(element: HTMLElement): string {
  const svg = element.querySelector("svg");
  if (svg) return [...svg.classList].find((name) => name.startsWith("lucide-")) ?? "svg";
  return element.textContent ?? "";
}

describe("StatusMarker", () => {
  it.each<[SourceControlStatus, string, string]>([
    ["added", "Added", "lucide-plus"],
    ["deleted", "Deleted", "lucide-minus"],
    ["removed", "Removed", "lucide-minus"],
    ["modified", "Modified", "M"],
    ["changed", "Changed", "M"],
  ])("marks %s with its word as the name and a %s glyph", (status, label, expected) => {
    render(<StatusMarker status={status} />);
    const marker = screen.getByRole("img", { name: label });
    expect(glyph(marker)).toBe(expected);
    // The letters it replaces never show.
    expect(marker.textContent).not.toMatch(/[AD]/);
  });

  it("puts the same glyph in a solid chip for a tile", () => {
    render(<StatusMarker status="added" variant="badge" />);
    const marker = screen.getByRole("img", { name: "Added" });
    expect(glyph(marker)).toBe("lucide-plus");
    expect(marker.className).toContain("bg-popover");
  });
});

describe("LockBadge", () => {
  it("names this device's lock and draws it filled with a plain lock", () => {
    render(<LockBadge state="mine" ownerName="ada" />);
    const badge = screen.getByRole("img", { name: "Locked By You" });
    expect(badge.getAttribute("title")).toBe("Locked By You");
    expect(badge.dataset.lockState).toBe("mine");
    expect(glyph(badge)).toBe("lucide-lock");
    expect(badge.className).toContain("bg-primary");
  });

  it("names someone else's lock by its holder and draws it outlined with a person", () => {
    render(<LockBadge state="theirs" ownerName="Bob" />);
    const badge = screen.getByRole("img", { name: "Locked By Bob" });
    expect(badge.getAttribute("title")).toBe("Locked By Bob");
    expect(badge.dataset.lockState).toBe("theirs");
    expect(glyph(badge)).toBe("lucide-user-lock");
    expect(badge.className).toContain("bg-popover");
    expect(badge.className).not.toContain("bg-primary");
  });

  it("names a holder the host did not name", () => {
    render(<LockBadge state="theirs" />);
    expect(screen.getByRole("img", { name: "Locked By Another User" })).toBeTruthy();
  });
});
