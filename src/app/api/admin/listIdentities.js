import "server-only";

const PAGE_SIZE = 500;
// 50 pages of 500: far above any expected user count, but a Kratos that keeps
// returning a next link (a bug or a loop) cannot keep the request running forever.
const MAX_PAGES = 50;

export class IdentityListError extends Error
{
	constructor(message, details)
	{
		super(message);
		this.name = "IdentityListError";
		this.details = details;
	}
}

function readIdentities(payload)
{
	const identities = Array.isArray(payload)
		? payload
		: payload?.identities || payload?.data?.identities || payload?.data;

	return Array.isArray(identities) ? identities : null;
}

// Kratos pages with a Link header (rel="next"). Only the query of that link is
// used: its host and path come from Kratos' own configured base URL, which can
// differ from the internal URL this server reaches it at.
function nextPageQuery(response)
{
	const link = response.headers.get("link") || "";
	const match = /<([^>]*)>\s*;\s*rel="?next"?/i.exec(link);

	if (!match)
	{
		return null;
	}

	const next = new URL(match[1], "http://kratos.invalid");

	if (!next.searchParams.has("page_token") && !next.searchParams.has("page"))
	{
		return null;
	}

	return next.searchParams;
}

/**
 * Reads every identity from the Kratos admin API, following its pagination.
 *
 * @param {object} options
 * @param {string} options.adminUrl Kratos admin base URL, without a trailing slash.
 * @param {number} options.timeoutMs Timeout for each page request.
 * @returns {Promise<{ identities: object[], truncated: boolean }>} `truncated` is true
 *   when the page limit was reached before Kratos reported the last page.
 * @throws {IdentityListError} When Kratos answers with an error or an unexpected body.
 */
export async function listAllIdentities({ adminUrl, timeoutMs })
{
	if (typeof adminUrl !== "string" || !adminUrl)
	{
		throw new TypeError("listAllIdentities: adminUrl must be a non-empty string");
	}

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
	{
		throw new RangeError("listAllIdentities: timeoutMs must be a positive number");
	}

	const identities = [];
	let query = new URLSearchParams({ page_size: String(PAGE_SIZE) });

	for (let page = 0; page < MAX_PAGES; page++)
	{
		const response = await fetch(`${adminUrl}/admin/identities?${query}`, {
			cache: "no-store",
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: "application/json" },
		});

		if (!response.ok)
		{
			throw new IdentityListError(`Kratos identity list returned ${response.status}`, { status: response.status });
		}

		const payload = await response.json();
		const pageIdentities = readIdentities(payload);

		if (pageIdentities === null)
		{
			throw new IdentityListError("Unexpected identity list format from Kratos", {
				status: response.status,
				payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
			});
		}

		identities.push(...pageIdentities);

		const nextQuery = nextPageQuery(response);

		if (nextQuery === null || pageIdentities.length === 0)
		{
			return { identities, truncated: false };
		}

		query = nextQuery;
	}

	return { identities, truncated: true };
}
