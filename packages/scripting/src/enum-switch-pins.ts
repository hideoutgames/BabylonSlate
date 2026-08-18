export const ENUM_SWITCH_CASE_PREFIX = "case:";

export function enumSwitchCasePinId(memberName: string): string {
  return `${ENUM_SWITCH_CASE_PREFIX}${memberName}`;
}

/** Member name from a Switch exec-out pin id (`case:Red`). Display names may Title Case. */
export function enumSwitchMemberNameFromPinId(
  pinId: string,
): string | undefined {
  return pinId.startsWith(ENUM_SWITCH_CASE_PREFIX)
    ? pinId.slice(ENUM_SWITCH_CASE_PREFIX.length)
    : undefined;
}
