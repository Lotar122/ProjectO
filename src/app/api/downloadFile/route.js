"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import { cookies } from "next/headers";
import postgres from "postgres";

export async function GET(req) {
    const DB = postgres(process.env.DB_URL, { prepare: true, ssl: 'require' });

    try {
        const { searchParams } = new URL(req.url);
        const fileKey = searchParams.get("file_id");

        if (!fileKey) {
            return new Response(JSON.stringify({ error: "file_id is required" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Auth check
        const cookieHeader = await cookies();
        const userAuthSession = await getUserAuthSession(cookieHeader);

        if (!userAuthSession.loggedIn) {
            return new Response(JSON.stringify({ error: "Forbidden" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
            });
        }

		const s3 = await createS3Client();

        // Fetch file from MinIO
        const file = await getFile(s3, "projecto", fileKey);

        return new Response(file.data, {
            status: 200,
            headers: {
                "Content-Type": file.contentType ?? "application/octet-stream",
                "Content-Disposition": `attachment; filename="${fileRecord.original_name}"`,
            },
        });

    } catch (err) {
        console.error("downloadFile error:", err);
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    } finally {
        DB.end();
    }
}
