import { cookies } from "next/headers";

import { jsonError, internalError } from "@/app/lib/apiErrors";
import { describeDbError } from "@/app/lib/dbError";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { KRATOS_ADMIN_URL } from "@/app/lib/kratosServer";
import { createLogger } from "@/app/lib/logger";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { countAccountOrders, deleteAccountData, previewAccountData } from "@/app/server-functions/deleteAccountData";
import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";

// GET previews the counts, DELETE removes the account with all its data (orders,
// files, ordering parties, user row, Kratos identity). The older
// /api/admin/deleteIdentity keeps orders and files and is unchanged.

const log = createLogger("admin");

// Returns the account id from `?id=` or the error response to send. Admin only; an admin cannot target their own account.
async function resolveTarget(request)
{
	const session = await getUserAuthSession(await cookies());

	if (!session.loggedIn || !isAdminSession(session))
	{
		return { error: jsonError("Admin access required", 403) };
	}

	const id = new URL(request.url).searchParams.get("id")?.trim();

	if (!isUuid(id))
	{
		return { error: jsonError("Identity id is required", 400) };
	}

	if (id === session.data.identity.id)
	{
		return { error: jsonError("Nie możesz usunąć własnego konta administratora.", 400) };
	}

	return { id, adminId: session.data.identity.id };
}

async function handlePreview(request)
{
	try
	{
		const target = await resolveTarget(request);

		if (target.error)
		{
			return target.error;
		}

		return Response.json({ success: true, ...await previewAccountData(target.id) });
	}
	catch (err)
	{
		log.error(`Failed to preview account data: ${describeDbError(err)}`);

		return internalError();
	}
}

// 404 counts as gone: a rerun after a partial failure, or an account whose identity was removed earlier.
async function deleteKratosIdentity(id)
{
	const response = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, {
		method: "DELETE",
		signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
	});

	return response.ok || response.status === 404;
}

function incompleteResponse({ id, adminId, counts })
{
	log.warn(`Account ${id} data deletion by admin ${adminId} incomplete: orders deleted ${counts.ordersDeleted}, files deleted ${counts.filesDeleted}, orders remaining ${counts.ordersRemaining}, leftovers ${counts.leftovers}`);

	return Response.json({
		success: false,
		error: `Nie udało się usunąć wszystkich danych (zlecenia: ${counts.ordersRemaining}, pozostałości archiwizacji: ${counts.leftovers}). Konto nie zostało usunięte. Spróbuj ponownie za chwilę.`,
		...counts,
	}, { status: 409 });
}

async function handleDelete(request)
{
	try
	{
		const target = await resolveTarget(request);

		if (target.error)
		{
			return target.error;
		}

		const { id, adminId } = target;
		const s3 = await createS3Client();
		const result = await deleteAccountData({ s3, userId: id });
		const counts = {
			ordersDeleted: result.ordersDeleted,
			filesDeleted: result.filesDeleted,
			partiesDeleted: result.partiesDeleted,
			ordersRemaining: result.ordersRemaining,
			leftovers: result.leftovers,
		};

		if (!result.complete)
		{
			return incompleteResponse({ id, adminId, counts });
		}

		// Right before the identity goes: an order created since the deletes above keeps the account.
		counts.ordersRemaining = await countAccountOrders(id);

		if (counts.ordersRemaining > 0)
		{
			return incompleteResponse({ id, adminId, counts });
		}

		let identityGone = false;

		try
		{
			identityGone = await deleteKratosIdentity(id);
		}
		catch
		{
			identityGone = false;
		}

		if (!identityGone)
		{
			log.error(`Account ${id}: data deleted by admin ${adminId} but the Kratos identity could not be removed`);

			return Response.json({
				success: false,
				error: "Dane konta zostały usunięte, ale nie udało się usunąć użytkownika z Ory Kratos. Spróbuj ponownie.",
				...counts,
			}, { status: 502 });
		}

		log.info(`Account ${id} deleted with all data by admin ${adminId}: orders ${counts.ordersDeleted}, files ${counts.filesDeleted}, parties ${counts.partiesDeleted}`);

		return Response.json({ success: true, ...counts });
	}
	catch (err)
	{
		log.error(`Failed to delete account data: ${describeDbError(err)}`);

		return internalError();
	}
}

export const GET = withRequestLogging(handlePreview);
export const DELETE = withRequestLogging(handleDelete);
