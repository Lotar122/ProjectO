import "server-only";

import { DB } from "@/app/lib/db";
import {
	MAX_SEARCH_LENGTH,
	escapeLikePattern,
	isOrderStatus,
	normalizeStatus,
} from "@/app/lib/validate";

export const ORDERS_PAGE_SIZE = 25;

export class InvalidOrderFilterError extends Error
{
	constructor(message)
	{
		super(message);
		this.name = "InvalidOrderFilterError";
	}
}

const toPositiveInt = (value, fallback) =>
{
	const parsed = Number.parseInt(value, 10);

	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Pages of orders for the list views. `userId` limits the list to one owner;
// null lists everyone's orders together with the owner's name (admin view).
// Throws InvalidOrderFilterError for a status or search the API can't serve.
export async function listOrders({ userId = null, page, limit, search, status })
{
	const pageSize = Math.min(toPositiveInt(limit, ORDERS_PAGE_SIZE), ORDERS_PAGE_SIZE);
	const requestedPage = toPositiveInt(page, 1);
	const searchValue = String(search ?? "").trim();
	const statusValue = normalizeStatus(status);

	if (searchValue.length > MAX_SEARCH_LENGTH)
	{
		throw new InvalidOrderFilterError("Search is too long");
	}

	if (statusValue && !isOrderStatus(statusValue))
	{
		throw new InvalidOrderFilterError("Unknown status");
	}

	const isAdminView = userId === null;
	const searchPattern = `%${escapeLikePattern(searchValue)}%`;

	const ownerFilter = isAdminView ? DB`` : DB`AND orders.user_id = ${userId}`;
	const statusFilter = statusValue ? DB`AND orders.status = ${statusValue}` : DB``;
	let searchFilter = DB``;

	if (searchValue)
	{
		searchFilter = isAdminView ?
			DB`
				AND (
					orders.patient ILIKE ${searchPattern}
					OR users.name ILIKE ${searchPattern}
					OR users.last_name ILIKE ${searchPattern}
					OR users.email ILIKE ${searchPattern}
					OR CONCAT_WS(' ', users.name, users.last_name) ILIKE ${searchPattern}
					OR CONCAT_WS(' ', users.last_name, users.name) ILIKE ${searchPattern}
				)
			` :
			DB`AND orders.patient ILIKE ${searchPattern}`;
	}

	// The owner join is only needed when its columns are searched or shown.
	const join = isAdminView ? DB`LEFT JOIN users ON users.user_id = orders.user_id` : DB``;
	const columns = isAdminView ?
		DB`
			orders.*,
			orders.user_id AS owner_user_id,
			users.email AS owner_email,
			users.name AS owner_name,
			users.last_name AS owner_last_name
		` :
		DB`orders.*`;
	const where = DB`WHERE TRUE ${ownerFilter} ${statusFilter} ${searchFilter}`;
	const countJoin = isAdminView && searchValue ? join : DB``;

	const fetchPage = (pageNumber) => DB`
		SELECT ${columns}
		FROM orders
		${join}
		${where}
		ORDER BY orders.issue_date DESC, orders.order_id DESC
		LIMIT ${pageSize}
		OFFSET ${(pageNumber - 1) * pageSize}
	`;

	const [countRows, firstTry] = await Promise.all([
		DB`SELECT COUNT(*)::int AS total FROM orders ${countJoin} ${where}`,
		fetchPage(requestedPage),
	]);

	const totalCount = Number(countRows[0]?.total || 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const safePage = Math.min(requestedPage, totalPages);
	// Both queries ran at once, so a page past the end is re-read once, clamped.
	const orders = safePage === requestedPage ? firstTry : await fetchPage(safePage);

	return {
		orders,
		page: safePage,
		pageSize,
		totalCount,
		totalPages,
	};
}
