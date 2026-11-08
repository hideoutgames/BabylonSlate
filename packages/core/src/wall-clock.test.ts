import { describe, expect, it } from "vitest";
import { utcCalendarDate, utcTimeOfDay } from "./wall-clock";

describe("wall clock", () => {
  it.each([
    ["the Unix epoch", "1970-01-01T00:00:00.000Z",
      { Hour: 0, Minute: 0, Second: 0, Millisecond: 0 },
      { Year: 1970, Month: 1, Day: 1, DayOfWeek: 4, DayOfYear: 1 }],
    ["the last millisecond of a leap day", "2024-02-29T23:59:59.999Z",
      { Hour: 23, Minute: 59, Second: 59, Millisecond: 999 },
      { Year: 2024, Month: 2, Day: 29, DayOfWeek: 4, DayOfYear: 60 }],
    ["the last day of a leap year", "2024-12-31T12:30:15.250Z",
      { Hour: 12, Minute: 30, Second: 15, Millisecond: 250 },
      { Year: 2024, Month: 12, Day: 31, DayOfWeek: 2, DayOfYear: 366 }],
    ["the last day of a common year", "2023-12-31T06:07:08.009Z",
      { Hour: 6, Minute: 7, Second: 8, Millisecond: 9 },
      { Year: 2023, Month: 12, Day: 31, DayOfWeek: 0, DayOfYear: 365 }],
    ["one millisecond before the epoch", "1969-12-31T23:59:59.999Z",
      { Hour: 23, Minute: 59, Second: 59, Millisecond: 999 },
      { Year: 1969, Month: 12, Day: 31, DayOfWeek: 3, DayOfYear: 365 }],
  ])("reads %s in UTC", (_label, iso, time, date) => {
    const unixMs = Date.parse(iso);
    expect(utcTimeOfDay(unixMs)).toEqual(time);
    expect(utcCalendarDate(unixMs)).toEqual(date);
  });
});
