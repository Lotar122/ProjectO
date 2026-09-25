"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { cookies } from "next/headers";
import postgres from "postgres";

const DEFAULT_PAGE_SIZE = 25;

const normalizeStatus = (value) =>
	String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");

export async function GET(request)
{
	let DB = null;

	try {
		const cookieHeader = await cookies();
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

		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

		const userId = userAuthSession.data.identity.id;
		const searchPattern = `%${searchValue}%`;
		const hasSearch = searchValue.length > 0;
		const hasStatus = statusValue.length > 0;

		let countRows = null;

		if (hasSearch && hasStatus)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE "user_id" = ${userId}
					AND patient ILIKE ${searchPattern}
					AND status = ${statusValue}
			`;
		} else if (hasSearch)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE "user_id" = ${userId}
					AND patient ILIKE ${searchPattern}
			`;
		} else if (hasStatus)
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE "user_id" = ${userId}
					AND status = ${statusValue}
			`;
		} else
		{
			countRows = await DB`
				SELECT COUNT(*)::int AS total
				FROM orders
				WHERE "user_id" = ${userId}
			`;
		}

		const totalCount = Number(countRows[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(totalCount / limit));
		const safePage = Math.min(page, totalPages);
		const offset = (safePage - 1) * limit;

		let orders = null;

		if (hasSearch && hasStatus)
		{
			orders = await DB`
				SELECT *
				FROM orders
				WHERE "user_id" = ${userId}
					AND patient ILIKE ${searchPattern}
					AND status = ${statusValue}
				ORDER BY issue_date DESC, order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else if (hasSearch)
		{
			orders = await DB`
				SELECT *
				FROM orders
				WHERE "user_id" = ${userId}
					AND patient ILIKE ${searchPattern}
				ORDER BY issue_date DESC, order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else if (hasStatus)
		{
			orders = await DB`
				SELECT *
				FROM orders
				WHERE "user_id" = ${userId}
					AND status = ${statusValue}
				ORDER BY issue_date DESC, order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		} else
		{
			orders = await DB`
				SELECT *
				FROM orders
				WHERE "user_id" = ${userId}
				ORDER BY issue_date DESC, order_id DESC
				LIMIT ${limit}
				OFFSET ${offset}
			`;
		}

		return new Response(JSON.stringify({
			orders,
			page: safePage,
			pageSize: limit,
			totalCount,
			totalPages,
		}), {
			headers: { "Content-Type": "application/json" },
		});
	} finally {
		await DB?.end();
	}
}
