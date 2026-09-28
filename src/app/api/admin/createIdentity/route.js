"use server";

import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";

const IDENTITY_SCHEMA_ID =
	process.env.KRATOS_IDENTITY_SCHEMA_ID ||
	"https://schemas.ory.sh/presets/kratos/quickstart/email-password/identity.schema.json";
const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["user", "admin"]);

const jsonError = (message, status) =>
	Response.json({ error: message }, { status });

export async function POST(request)
{
	try
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		let payload;

		try
		{
			payload = await request.json();
		}
		catch
		{
			return jsonError("Nieprawidłowe dane formularza.", 400);
		}

		const email = String(payload?.email || "").trim().toLowerCase();
		const password = String(payload?.password || "");
		const role = String(payload?.role || "").trim();
		const firstName = String(payload?.firstName || "").trim();
		const lastName = String(payload?.lastName || "").trim();

		if (!EMAIL_PATTERN.test(email))
		{
			return jsonError("Wpisz poprawny adres e-mail.", 400);
		}

		if (password.length < 8)
		{
			return jsonError("Hasło musi mieć co najmniej 8 znaków.", 400);
		}

		if (!VALID_ROLES.has(role))
		{
			return jsonError("Wybierz poprawną rolę użytkownika.", 400);
		}

		const traits = {
			email,
			role,
		};

		if (firstName || lastName)
		{
			traits.name = {
				first: firstName,
				last: lastName,
			};
		}

		const response = await fetch(`${KRATOS_ADMIN_URL}/admin/identities`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				schema_id: IDENTITY_SCHEMA_ID,
				traits,
				credentials: {
					password: {
						config: {
							password,
						},
					},
				},
			}),
		});

		if (!response.ok)
		{
			let errorData = null;

			try
			{
				errorData = await response.json();
			}
			catch
			{
				// Keep a stable error response if Kratos returns a non-JSON body.
			}

			const kratosMessage =
				errorData?.error?.reason ||
				errorData?.error?.message ||
				errorData?.message;

			return jsonError(
				kratosMessage || "Nie udało się utworzyć tożsamości w Ory Kratos.",
				response.status >= 400 && response.status < 500 ? response.status : 502,
			);
		}

		const identity = await response.json();

		return Response.json({
			success: true,
			identity: {
				id: identity.id,
				email,
				role,
			},
		});
	}
	catch (error)
	{
		console.error("Nie udało się utworzyć tożsamości:", error);

		return jsonError("Nie udało się połączyć z Ory Kratos.", 502);
	}
}
