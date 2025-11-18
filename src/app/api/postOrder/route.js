"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";

import postgres from "postgres";

import {v7 as uuid7 } from "uuid"

//Has to be used with credentials
export async function POST(req) {
  try {
    const body = await req.json();     // read JSON request body
    const { patient, type, status, progress, issueDate, dueDate } = body;

    const cookieHeader = await cookies();
    const userAuthSession = await getUserAuthSession(cookieHeader);

    if(!userAuthSession.loggedIn)
    {
        return new Response(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
        );
    }

    const orderID = uuid7();
    const userID = userAuthSession.data.identity.id;

    const DB = postgres(Bun.env.DB_URL, {prepare: true});

    await DB`
        INSERT INTO orders (id, user, patient, type, status, progress, issue_date, due_date)
		VALUES (${orderID}, ${userID}, ${patient}, ${type}, ${status}, ${progress}, ${issueDate}, ${dueDate})
    `;

    return Response.json(
      { success: true, message: "Order created", body },
      { status: 200 }
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}