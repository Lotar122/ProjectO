"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteFileFromMinio } from "@/app/server-functions/MinIO/deleteFile";

import { cookies } from "next/headers";

import postgres from "postgres";

import {v7 as uuid7 } from "uuid"

//Has to be used with credentials
export async function DELETE(req) {
  try {
    const cookieHeader = await cookies();
    const userAuthSession = await getUserAuthSession(cookieHeader);

    if(!userAuthSession.loggedIn)
    {
        return new Response(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
        );
    }

    const url = new URL(req.url);
    const orderID = url.searchParams.get("orderID");

    const DB = postgres(process.env.DB_URL, {prepare: true});

    const [order] = await DB`SELECT * FROM orders WHERE order_id = ${orderID};`;

    if(order.user_id === userAuthSession.data.identity.id)
    {
      const s3 = await createS3Client();
      await Promise.all(
        order.files.map(file => deleteFileFromMinio(s3, "projecto", file))
      );
      await DB`DELETE FROM orders WHERE order_id = ${orderID};`;
    }

    DB.end();

    return Response.json(
      { success: true },
      { status: 200 }
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}