/**
 * fflate encodes DOS dates with local getFullYear/getMonth/…. UTC midnight
 * 1980-01-01 is still 1979 in US timezones and throws "date not in range
 * 1980-2099". Local noon stays in range everywhere.
 */
export const SAFE_ZIP_MTIME = new Date(1980, 0, 1, 12, 0, 0);
