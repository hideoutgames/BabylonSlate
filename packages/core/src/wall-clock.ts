/**
 * Wall-clock values for the Time nodes. Field names are the engine Time and Date
 * Structures' (`engine:Time`, `engine:Date` in scripting), so a script reads them
 * with Break Structure. Both read UTC, so a Time and a Date of one instant agree.
 */

/** UTC time of day (Get Time Now): whole numbers, kept as Floats by the Time Structure. */
export type UtcTimeOfDay = { Hour: number; Minute: number; Second: number; Millisecond: number };

/** UTC calendar date (Get Date Now): Month and Day count from 1, Day Of Week from Sunday (0). */
export type UtcCalendarDate = { Year: number; Month: number; Day: number; DayOfWeek: number; DayOfYear: number };

const MS_PER_DAY = 86_400_000;

/** The UTC time of day at `unixMs`, milliseconds since 1970-01-01T00:00:00Z. */
export function utcTimeOfDay(unixMs: number): UtcTimeOfDay {
  const date = new Date(unixMs);
  return {
    Hour: date.getUTCHours(),
    Minute: date.getUTCMinutes(),
    Second: date.getUTCSeconds(),
    Millisecond: date.getUTCMilliseconds(),
  };
}

/** The UTC calendar date at `unixMs`, milliseconds since 1970-01-01T00:00:00Z. */
export function utcCalendarDate(unixMs: number): UtcCalendarDate {
  const date = new Date(unixMs);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(0);
  startOfYear.setUTCFullYear(year, 0, 1);
  const startOfDay = unixMs - (((unixMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY);
  return {
    Year: year,
    Month: date.getUTCMonth() + 1,
    Day: date.getUTCDate(),
    DayOfWeek: date.getUTCDay(),
    DayOfYear: Math.round((startOfDay - startOfYear.getTime()) / MS_PER_DAY) + 1,
  };
}
