import { describe, expect, it } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  layoutUserInterface,
  pinLayout,
} from "./index";

describe("describeUiControls", () => {
  it("flips engine-space Y into Babylon GUI top-left", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "play",
      "Button",
      "Play",
      pinLayout({ x: 0, y: 0 }, { x: 80, y: 32 }, { x: 0, y: 0 }),
    );
    button.props.text = "Play";
    doc.widgets.canvas!.children = ["play"];
    doc.widgets.play = button;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout, 1080);
    const play = controls.find((row) => row.id === "play");
    expect(play?.text).toBe("Play");
    expect(play?.guiRect.y).toBeGreaterThan(0);
    expect(play?.guiRect.y).toBe(1080 - (play?.guiRect.height ?? 0));
  });
});
