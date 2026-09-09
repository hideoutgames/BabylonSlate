import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxIcon } from "lucide-react";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { HomepageProjectCard } from "./homepage-project-card";
import { TemplatePickCard } from "./homepage-template-card";

afterEach(cleanup);

function card(kind: "project" | "template", scrolling = false) {
  const activate = vi.fn();
  render(
    <div className="homepage-pages" data-scrolling={scrolling}>
      {kind === "project" ? (
        <HomepageProjectCard
          project={{
            id: "opfs:Orbit",
            name: "Orbit",
            label: "Orbit",
            tier: "opfs",
          }}
          busy={false}
          deleting
          onOpen={activate}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      ) : (
        <TemplatePickCard
          title="Basic 3D"
          testId="template"
          icon={BoxIcon}
          onSelect={activate}
        />
      )}
    </div>,
  );
  const target = screen.getByRole("button", {
    name: kind === "project" ? "Open Project Orbit" : "Basic 3D",
  });
  const pointer = (
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    x = 50,
  ) => {
    act(() => dispatchPointerEvent(target, type, { clientX: x, clientY: 50 }));
  };
  return { target, activate, pointer };
}

describe.each(["project", "template"] as const)(
  "%s card touch activation",
  (kind) => {
    it("does not activate a swipe but accepts the next fresh tap", () => {
      const { target, activate, pointer } = card(kind);
      pointer("pointerdown");
      pointer("pointermove", 80);
      pointer("pointerup", 80);
      fireEvent.click(target, { detail: 1 });
      expect(activate).not.toHaveBeenCalled();
      pointer("pointerdown");
      pointer("pointerup");
      fireEvent.click(target, { detail: 1 });
      expect(activate).toHaveBeenCalledTimes(1);
    });

    it("does not activate a cancelled gesture and still accepts keyboard activation", () => {
      const { target, activate, pointer } = card(kind);
      pointer("pointerdown");
      pointer("pointercancel");
      fireEvent.click(target, { detail: 1 });
      expect(activate).not.toHaveBeenCalled();
      fireEvent.click(target, { detail: 0 });
      expect(activate).toHaveBeenCalledTimes(1);
    });

    it("lets a touch stop scrolling without opening the card", () => {
      const { target, activate, pointer } = card(kind, true);
      pointer("pointerdown");
      pointer("pointerup");
      fireEvent.click(target, { detail: 1 });
      expect(activate).not.toHaveBeenCalled();
    });
  },
);
