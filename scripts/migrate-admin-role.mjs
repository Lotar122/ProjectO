#!/usr/bin/env bun
// One-time migration: copies the admin role from the user-editable identity
// trait (traits.role) to metadata_public.role, which only the Kratos admin API
// can write. The app reads metadata_public.role (see isAdminSession.js).
//
//   KRATOS_ADMIN_URL=http://kratos:4434 bun scripts/migrate-admin-role.mjs            (dry run)
//   KRATOS_ADMIN_URL=http://kratos:4434 bun scripts/migrate-admin-role.mjs --apply    (writes)
//
// Without --apply (or with --dry-run, which overrides --apply) nothing is written: the script only lists the identities it
// would promote. Until now traits.role could be edited by the user, so anyone
// who set it to "admin" themselves is listed too. Check the list, demote anyone
// who should not be an admin (set their traits.role to something else), and
// only then run it again with --apply.
//
// Idempotent: identities that already have metadata_public.role are skipped.
// traits.role is left untouched.
//
// The PATCH only adds metadata_public.role and first tests that traits.role is
// still "admin", so a demotion made between the read and the write is not
// overwritten. JSON Patch cannot test that a key is absent, so how far it guards
// against a concurrent change depends on the identity:
//   - metadata_public exists: only traits.role is tested. If another writer set
//     metadata_public.role in the meantime, the "add" replaces that value.
//   - metadata_public is missing or null: it is also tested to still equal what
//     was read, so any change to it makes Kratos reject the patch.
// A rejected identity is reported as failed and can be checked and rerun.

const KRATOS_ADMIN_URL = (process.env.KRATOS_ADMIN_URL || "http://kratos:4434").replace(/\/$/, "");
const TIMEOUT_MS = 10000;
const PAGE_SIZE = 250;
// --dry-run wins over --apply, so combining them never writes.
const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
const prefix = apply ? "" : "[dry-run] ";

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

function isPlainObject(value)
{
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// JSON Patch (RFC 6902) that only sets metadata_public.role. The "test" ops make
// Kratos reject the whole patch when the identity changed since it was read.
function promotionPatch(identity)
{
	const guard = [{ op: "test", path: "/traits/role", value: "admin" }];

	if (isPlainObject(identity.metadata_public))
	{
		return [
			...guard,
			{ op: "add", path: "/metadata_public/role", value: "admin" },
		];
	}

	return [
		...guard,
		{ op: "test", path: "/metadata_public", value: identity.metadata_public ?? null },
		{ op: "add", path: "/metadata_public", value: { role: "admin" } },
	];
}

const summary = { migrated: 0, skipped: 0, failed: 0 };
let pageToken = null;

if (!apply)
{
	console.log("[dry-run] Nothing is written. Check the list below, then run again with --apply.");
}

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

		if (!apply)
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
				body: JSON.stringify(promotionPatch(identity)),
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

console.log(`${prefix}migrated: ${summary.migrated}, skipped: ${summary.skipped}, failed: ${summary.failed}`);
process.exit(summary.failed > 0 ? 1 : 0);
