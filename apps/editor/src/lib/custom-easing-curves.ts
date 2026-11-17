import { customEasingCurve, type CustomEasingCurveRef } from "@haptic/core";
import { walkAncestry } from "@haptic/editor-kit";
import { CUSTOM_EASING_CURVE_CLASS_ID } from "@haptic/object-model";
import { classIdFromClassAsset, classParentLookup } from "./class-asset-lookup";

type CurveClassAsset = {
  path?: string;
  header: { type: string; name?: string; parentClass?: string | null };
};

/**
 * The project's custom easing curves: every Class asset deriving from Custom Easing Curve (not the base), as
 * `class:<ClassId>`, sorted by Class id. Lists offer them after the built-in curves as `<Class> (Custom)`.
 */
export function projectCustomEasingCurves(assets: ReadonlyArray<CurveClassAsset>): CustomEasingCurveRef[] {
  const classes = assets.flatMap((asset) => asset.header.type === "Class"
    ? [{ path: asset.path, header: { type: "Class", name: asset.header.name ?? "", parentClass: asset.header.parentClass } }]
    : []);
  if (classes.length === 0) return [];
  const parentOf = classParentLookup(classes);
  const classIds = new Set<string>();
  for (const asset of classes) {
    const classId = classIdFromClassAsset(asset);
    if (classId !== CUSTOM_EASING_CURVE_CLASS_ID && walkAncestry(classId, parentOf).includes(CUSTOM_EASING_CURVE_CLASS_ID)) classIds.add(classId);
  }
  return [...classIds].sort().map(customEasingCurve);
}
