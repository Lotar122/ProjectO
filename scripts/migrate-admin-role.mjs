// One-time migration: copies the admin role from the user-editable identity
// trait (traits.role) to metadata_public.role, which only the Kratos admin API
// can write. The app reads metadata_public.role (see isAdminSession.js).
//
//   KRATOS_ADMIN_URL=http://kratos:4434 node scripts/migrate-admin-role.mjs [--dry-run]
//
// Run with --dry-run first and check the list: until now traits.role could be
// edited by the user, so anyone who set it to "admin" themselves is listed too.
//
// Idempotent: identities that already have metadata_public.role are skipped.
// traits.role is left untouched.

const KRATOS_ADMIN_URL = (process.env.KRATOS_ADMIN_URL || "http://kratos:4434").replace(/\/$/, "");
const TIMEOUT_MS = 10000;
const PAGE_SIZE = 250;
const dryRun = process.argv.includes("--dry-run");

async function kratos(path, init = {})
{
	const response = await fetch(`${KRATOS_ADMIN_URL}${path}`, {
		...init,
		headers: { Accept: "application/json", ...init.headers },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});

	if (!response.ok)
	{
		throw new Error(`${init.method || "GET"} ${path} -> ${response.status} ${await response.text()}`);
	}

	return response;
}

// Kratos paginates with a token in the Link header (rel="next").
function nextPageToken(response)
{
	const match = /<[^>]*[?&]page_token=([^&>]+)[^>]*>;\s*rel="next"/.exec(response.headers.get("link") || "");

	return match ? decodeURIComponent(match[1]) : null;
}

const summary = { migrated: 0, skipped: 0, failed: 0 };
let pageToken = null;

do
{
	const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });

	if (pageToken)
	{
		query.set("page_token", pageToken);
	}

	const response = await kratos(`/admin/identities?${query}`);
	const identities = await response.json();

	for (const identity of identities)
	{
		if (identity.traits?.role !== "admin" || identity.metadata_public?.role)
		{
			summary.skipped++;
			continue;
		}

		const label = `${identity.id} (${identity.traits?.email ?? "no email"})`;

		if (dryRun)
		{
			console.log(`[dry-run] would migrate ${label}`);
			summary.migrated++;
			continue;
		}

		try
		{
			await kratos(`/admin/identities/${encodeURIComponent(identity.id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([
					{
						op: "add",
						path: "/metadata_public",
						value: { ...identity.metadata_public, role: "admin" },
					},
				]),
			});
			console.log(`migrated ${label}`);
			summary.migrated++;
		}
		catch (err)
		{
			console.error(`FAILED ${label}: ${err.message}`);
			summary.failed++;
		}
	}

	pageToken = nextPageToken(response);
}
while (pageToken);

console.log(`${dryRun ? "[dry-run] " : ""}migrated: ${summary.migrated}, skipped: ${summary.skipped}, failed: ${summary.failed}`);
process.exit(summary.failed > 0 ? 1 : 0);
