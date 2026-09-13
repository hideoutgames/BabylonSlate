import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DisclosureSection } from "./disclosure-section";

afterEach(cleanup);

function Category() {
  const [open, setOpen] = useState(false);
  return <DisclosureSection title="Shadows" open={open} onOpenChange={setOpen}><span>Shadow Distance</span></DisclosureSection>;
}

it("keeps a named disclosure operable when collapsed and links its controlled content", () => {
  render(<Category />);
  const trigger = screen.getByRole("button", { name: "Shadows" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Shadow Distance")).toBeNull();
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(trigger.getAttribute("aria-controls")!)?.textContent).toBe("Shadow Distance");
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByText("Shadow Distance")).toBeNull();
});
