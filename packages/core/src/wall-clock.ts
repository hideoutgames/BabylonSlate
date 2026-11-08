/**
 * Wall-clock values for the Time nodes. Field names are the engine Time and Date
 * Structures' (`engine:Time`, `engine:Date` in scripting), so a script reads them
 * with Break Structure. The UTC pair agree with each other, as do the local pair.
 */

/** Time of day (Get Time Now, Get Local Time Now): whole numbers, kept as Floats by the Time Structure. */
export type TimeOfDay = { Hour: number; Minute: number; Second: number; Millisecond: number };

/** Calendar date (Get Date Now, Get Local Date Now): Month and Day count from 1, Day Of Week from Sunday (0). */
export type CalendarDate = { Year: number; Month: number; Day: number; DayOfWeek: number; DayOfYear: number };

const MS_PER_DAY = 86_400_000;

/** The UTC time of day at `unixMs`, milliseconds since 1970-01-01T00:00:00Z. */
export function utcTimeOfDay(unixMs: number): TimeOfDay {
  const date = new Date(unixMs);
  return {
    Hour: date.getUTCHours(),
    Minute: date.getUTCMinutes(),
    Second: date.getUTCSeconds(),
    Millisecond: date.getUTCMilliseconds(),
  };
}

/** The time of day at `unixMs` in the device's time zone. */
export function localTimeOfDay(unixMs: number): TimeOfDay {
  const date = new Date(unixMs);
  return {
    Hour: date.getHours(),
    Minute: date.getMinutes(),
    Second: date.getSeconds(),
    Millisecond: date.getMilliseconds(),
  };
}

/** The UTC calendar date at `unixMs`. */
export function utcCalendarDate(unixMs: number): CalendarDate {
  const date = new Date(unixMs);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(0);
  startOfYear.setUTCFullYear(year, 0, 1);
  const startOfDay = new Date(0);
  startOfDay.setUTCFullYear(year, date.getUTCMonth(), date.getUTCDate());
  return {
    Year: year,
    Month: date.getUTCMonth() + 1,
    Day: date.getUTCDate(),
    DayOfWeek: date.getUTCDay(),
    DayOfYear: Math.round((startOfDay.getTime() - startOfYear.getTime()) / MS_PER_DAY) + 1,
  };
}

/** The calendar date at `unixMs` in the device's time zone. A daylight saving change shifts days by an hour, which the rounding absorbs. */
export function localCalendarDate(unixMs: number): CalendarDate {
  const date = new Date(unixMs);
  const year = date.getFullYear();
  const startOfYear = new Date(unixMs);
  startOfYear.setFullYear(year, 0, 1);
  startOfYear.setHours(0, 0, 0, 0);
  const startOfDay = new Date(unixMs);
  startOfDay.setHours(0, 0, 0, 0);
  return {
    Year: year,
    Month: date.getMonth() + 1,
    Day: date.getDate(),
    DayOfWeek: date.getDay(),
    DayOfYear: Math.round((startOfDay.getTime() - startOfYear.getTime()) / MS_PER_DAY) + 1,
  };
}
