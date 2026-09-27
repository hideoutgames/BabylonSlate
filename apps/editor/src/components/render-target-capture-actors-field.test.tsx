import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createActor } from "@babylonslate/core";
import { RenderTargetCaptureActorsField } from "./render-target-capture-actors-field";

afterEach(cleanup);
it("selects scene actor references, excludes duplicates and removes list entries", async () => {
  let stored: string[] = [];
  function Harness() {
    const [actorIds, setActorIds] = useState<string[]>([]);
    stored = actorIds;
    return <RenderTargetCaptureActorsField actorIds={actorIds} actors={[createActor("hero", "Hero"), createActor("wall", "Wall")]} onChange={setActorIds} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add Actor" }));
  fireEvent.click(await screen.findByRole("option", { name: /Hero/ }));
  expect(stored).toEqual(["hero"]);
  fireEvent.click(screen.getByRole("button", { name: "Add Actor" }));
  expect(screen.queryByRole("option", { name: /Hero/ })).toBeNull();
  fireEvent.click(await screen.findByRole("option", { name: /Wall/ }));
  expect(stored).toEqual(["hero", "wall"]);
  fireEvent.click(screen.getByTestId("entry-list-0-remove"));
  expect(stored).toEqual(["wall"]);
});
