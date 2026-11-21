// Input validation shared by the API routes, so malformed input is answered
// with a 400 instead of reaching Postgres/S3 and coming back as a 500.

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A calendar date, optionally followed by an ISO time ("T12:30", "T12:30:00.000Z",
// "T00:30:00+02:00"). Groups: date, year, month, day, time.
const DATE_PATTERN =
	/^((\d{4})-(\d{2})-(\d{2}))(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export const ORDER_STATUSES = ["pending", "in-progress", "shipped", "completed"];

// Statuses in which the owner may still edit or delete an order. From "shipped"
// on only an admin can change it; unknown and NULL statuses are locked too.
export const OWNER_EDITABLE_STATUSES = ["pending", "in-progress"];

export const MAX_PATIENT_LENGTH = 200;
export const MAX_DETAILS_LENGTH = 5000;
export const MAX_SEARCH_LENGTH = 100;

export function isUuid(value)
{
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeStatus(value)
{
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
}

export function isOrderStatus(value)
{
	return ORDER_STATUSES.includes(value);
}

/**
 * True when the owner of an order in this status may still edit or delete it.
 * Fails closed: unknown values, NULL and differently cased values are locked.
 *
 * @param {unknown} status Raw `orders.status` value.
 * @returns {boolean}
 */
export function isOwnerEditableStatus(status)
{
	return OWNER_EDITABLE_STATUSES.includes(status);
}

// True when year/month/day name a real calendar day (no 2026-02-30).
function isCalendarDate(year, month, day)
{
	const date = new Date(0);

	// setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
	date.setUTCFullYear(year, month - 1, day);

	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// True for the time part matched by DATE_PATTERN when its hours, minutes,
// seconds and offset are in range.
function isClockTime(timePart)
{
	const [, hours, minutes, seconds = "00", offsetHours = "00", offsetMinutes = "00"] =
		/^T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/.exec(timePart);

	return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59 &&
		Number(offsetHours) <= 23 && Number(offsetMinutes) <= 59;
}

/**
 * Reads a due date. Accepts "YYYY-MM-DD" (what <input type="date"> sends) or
 * an ISO date-time that starts with one. The calendar date is taken as written:
 * a time or time zone offset after it never moves the result to another day.
 * Years are limited to 0001-9999, so an expanded year such as "+275760-09-13"
 * is a 400 instead of a value Postgres rejects with a 500.
 *
 * @param {unknown} value Raw form or query value.
 * @returns {string | null | undefined} "YYYY-MM-DD", null for an empty value,
 *   undefined for an invalid one.
 */
export function parseDateInput(value)
{
	const text = String(value ?? "").trim();

	if (!text)
	{
		return null;
	}

	const match = DATE_PATTERN.exec(text);

	if (!match)
	{
		return undefined;
	}

	const [, datePart, yearText, monthText, dayText, timePart] = match;
	const year = Number(yearText);

	if (year < 1 || !isCalendarDate(year, Number(monthText), Number(dayText)))
	{
		return undefined;
	}

	if (timePart !== undefined && !isClockTime(timePart))
	{
		return undefined;
	}

	return datePart;
}

// ILIKE treats % and _ as wildcards; user search terms must match literally.
export function escapeLikePattern(value)
{
	return String(value).replace(/[\\%_]/g, "\\$&");
}

export function readText(value, maxLength)
{
	const text = typeof value === "string" ? value.trim() : "";

	return text.length > maxLength ? undefined : text;
}
