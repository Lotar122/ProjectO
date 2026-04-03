"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";

import postgres from "postgres";

export async function GET() {
  let payload = null;

  let cookieHeader = await cookies(); // get cookies from request
  
  let userAuthSession = await getUserAuthSession(cookieHeader);

  if(!userAuthSession.loggedIn) 
  {
    return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const DB = postgres(Bun.env.DB_URL, {prepare: true});

  payload = await DB`SELECT * FROM orders WHERE "user_id" = ${userAuthSession.data.identity.id};`;

  DB.end();

  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}