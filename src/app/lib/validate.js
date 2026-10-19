// Input validation shared by the API routes, so malformed input is answered
// with a 400 instead of reaching Postgres/S3 and coming back as a 500.

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const ORDER_STATUSES = ["pending", "in-progress", "shipped", "completed"];

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

// Accepts "YYYY-MM-DD" (what <input type="date"> sends) or a full ISO string.
// Returns null for an empty value and undefined for an invalid one.
export function parseDateInput(value)
{
	const text = String(value ?? "").trim();

	if (!text)
	{
		return null;
	}

	const date = new Date(text);

	if (Number.isNaN(date.getTime()) || (!DATE_PATTERN.test(text) && !text.includes("T")))
	{
		return undefined;
	}

	return date.toISOString().split("T")[0];
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
