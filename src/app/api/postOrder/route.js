"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";

import postgres from "postgres";

export async function POST(req) {
  try {
    const body = await req.json();     // read JSON request body
    const { patient, type, status, progress, issueDate, dueDate } = body;

    // Do something with the data...
    // e.g., save to DB

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