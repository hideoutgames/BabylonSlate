export const UI_CONTROL_2D_CLASS_IDS = [
  "2DSliderComponent", "2DRangeSliderComponent", "2DCheckboxComponent",
  "2DRadioButtonComponent", "2DToggleComponent", "2DTextInputComponent",
  "2DNumericInputComponent", "2DDropdownComponent", "2DProgressBarComponent",
] as const;
export type UIControl2DClassId = (typeof UI_CONTROL_2D_CLASS_IDS)[number];

export function isUIControl2DClass(classId: string): classId is UIControl2DClassId {
  return (UI_CONTROL_2D_CLASS_IDS as readonly string[]).includes(classId);
}
export function isInteractiveUIControl2DClass(classId: string): boolean {
  return isUIControl2DClass(classId) && classId !== "2DProgressBarComponent";
}
