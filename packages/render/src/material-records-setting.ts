/** Browser storage key of the `materialrecords` debug setting. */
const MATERIAL_RECORDS_KEY = "haptic:debug:materialRecords";

/**
 * Whether the project Engine starts with graph Materials reading the Material record (`material-record.ts`): off
 * unless the `materialrecords on` debug command stored it. Read when the project Engine is created (an editor reload,
 * or reopening the project), so the load, its warm-up and every Scene of that Engine compile with the record from the
 * start, which a mid-session `worlddebug materialrecords on` cannot measure. Free of Babylon, like
 * `preserve-drawing-buffer-setting.ts`.
 */
export function materialRecordsStartupSetting(): boolean {
  try {
    return globalThis.localStorage?.getItem(MATERIAL_RECORDS_KEY) === "on";
  } catch {
    return false;
  }
}

/** Debug (`materialrecords on|off`): store the setting for the next project Engine. */
export function setMaterialRecordsStartupSetting(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(MATERIAL_RECORDS_KEY, "on");
    else globalThis.localStorage?.removeItem(MATERIAL_RECORDS_KEY);
  } catch {
    // Storage unavailable (a private window): the setting stays off.
  }
}
