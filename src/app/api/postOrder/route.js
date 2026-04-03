"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { cookies } from "next/headers";
import postgres from "postgres";
import { v7 as uuid7 } from "uuid";

// Server POST function for inserting orders
export async function POST(req) {
  const DB = postgres(process.env.DB_URL, { prepare: true });

  try {
    const body = await req.json();
    const { patient, details, status, progress, issueDate, dueDate } = body;

    // Get user session
    const cookieHeader = await cookies();
    const userAuthSession = await getUserAuthSession(cookieHeader);

    if (!userAuthSession.loggedIn) {
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const orderID = uuid7();
    const userID = userAuthSession.data.identity.id;

    // Convert dates to ISO strings (YYYY-MM-DD) or null
    const issue_date = issueDate ? new Date(issueDate).toISOString().split("T")[0] : null;
    const due_date = dueDate ? new Date(dueDate).toISOString().split("T")[0] : null;

    // Insert into DB safely
    await DB`
      INSERT INTO orders (
        order_id, user_id, patient, details, status, progress, issue_date, due_date
      ) VALUES (
        ${orderID}, ${userID}, ${patient}, ${details}, ${status}, ${progress}, ${issue_date}, ${due_date}
      )
    `;

    return new Response(
      JSON.stringify({ success: true, orderID, body }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );

  } finally {
    // Always close DB connection
    DB.end();
  }
}