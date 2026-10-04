import { expect, it } from "vitest";
import { focusPropertyRows } from "./focus-property-rows";

it("authors explicit neighbors without losing automatic navigation or offering a self link", () => {
  const changes: Array<[string, unknown]> = [];
  const rows = focusPropertyRows("actor", { id: "focus", classId: "2DFocusTargetComponent", properties: { focusRight: "other" } },
    (key, value) => changes.push([key, value]), [{ value: "focus", label: "Self" }, { value: "other", label: "Other" }]);
  const right = rows.find((row) => row.id === "actor-focus-focusRight");
  if (right?.kind !== "enum") throw new Error("Missing neighbor field");
  expect(right.value).toBe("other");
  expect(right.options).toEqual([{ value: "", label: "Automatic" }, { value: "other", label: "Other" }]);
  right.onChange("");
  expect(changes).toEqual([["focusRight", null]]);
});
