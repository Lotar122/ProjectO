"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { cookies } from "next/headers";
import postgres from "postgres";

const DEFAULT_PAGE_SIZE = 25;

const normalizeStatus = (value) =>
	String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");

const jsonError = (message, status) =>
	new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});

export async function GET(request)
{
	let DB = null;

	try {
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn)
		{
			return jsonError("Forbidden", 403);
		}

		if (!isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		const { searchParams } = new URL(request.url);
		const requestedPage = Number.parseInt(searchParams.get("page") || "1", 10);
		const requestedLimit = Number.parseInt(
			searchParams.get("limit") || String(DEFAULT_PAGE_SIZE),
			10,
		);
		const searchValue = searchParams.get("search")?.trim() || "";
		const statusValue = normalizeStatus(searchParams.get("status") || "");
		const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
		const limit =
			Number.isFinite(requestedLimit) && requestedLimit > 0
				? Math.min(requestedLimit, DEFAULT_PAGE_SIZE)
				: DEFAULT_PAGE_SIZE;
		const searchPattern = `%${searchValue}%`;
		const hasSearch = searchValue.length > 0;
		const hasStatus = statusValue.length > 0;

		DB = postgres(process.env.DB_URL, { prepare: true, /*ssl: "require"*/ });

		let countRows = null;

		if (hasSearch && hasStatus)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE patient ILIKE ${searchPattern}
					AND status = ${statusValue}
			`;
		} else if (hasSearch)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE patient ILIKE ${searchPattern}
			`;
		} else if (hasStatus)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE status = ${statusValue}
			`;
		} else
		{
			countRows = await DB`SELECT COUNT(*)::int AS total FROM orders`;
		}

		const totalCount = Number(countRows[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(totalCount / limit));
		const safePage = Math.min(page, totalPages);
		const offset = (safePage - 1) * limit;
		let orders = null;

		const ownerFields = DB`
			orders.user_id AS owner_user_id,
			users.email AS owner_email,
			users.name AS owner_name,
			users.last_name AS owner_last_name
		`;

		if (hasSearch && hasStatus)
		{
			orders = await DB`
				SELECT orders.*, ${ownerFields}
				FROM orders
				LEFT JOIN users ON users.user_id = orders.user_id
				WHERE orders.patient ILIKE ${searchPattern}
					AND orders.status = ${statusValue}
				ORDER BY orders.issue_date DESC, orders.order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else if (hasSearch)
		{
			orders = await DB`
				SELECT orders.*, ${ownerFields}
				FROM orders
				LEFT JOIN users ON users.user_id = orders.user_id
				WHERE orders.patient ILIKE ${searchPattern}
				ORDER BY orders.issue_date DESC, orders.order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else if (hasStatus)
		{
			orders = await DB`
				SELECT orders.*, ${ownerFields}
				FROM orders
				LEFT JOIN users ON users.user_id = orders.user_id
				WHERE orders.status = ${statusValue}
				ORDER BY orders.issue_date DESC, orders.order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else
		{
			orders = await DB`
				SELECT orders.*, ${ownerFields}
				FROM orders
				LEFT JOIN users ON users.user_id = orders.user_id
				ORDER BY orders.issue_date DESC, orders.order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		}

		return Response.json({
			orders,
			page: safePage,
			pageSize: limit,
			totalCount,
			totalPages,
		});
	} finally {
		await DB?.end();
	}
}
