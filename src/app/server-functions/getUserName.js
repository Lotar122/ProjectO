"use server";

export async function getNameFromEmail(email)
{
	const url =
		"http://host.docker.internal:4434/admin/identities?credentials_identifier=" +
		encodeURIComponent(email);

	console.log("[KRATOS-ADMIN] Looking up identity");
	console.log("[KRATOS-ADMIN] URL:", url);
	console.log("[KRATOS-ADMIN] Email:", email);

	try
	{
		const res = await fetch(url, {
			headers: {
				"Content-Type": "application/json",
			},
		});

		console.log("[KRATOS-ADMIN] Status:", res.status);
		console.log("[KRATOS-ADMIN] Status text:", res.statusText);

		const responseText = await res.text();

		console.log("[KRATOS-ADMIN] Response:", responseText);

		if (!res.ok)
		{
			console.error(
				"[KRATOS-ADMIN] Request failed:",
				{
					status: res.status,
					statusText: res.statusText,
					response: responseText,
				},
			);

			throw new Error(
				`Kratos admin request failed: ${res.status} ${res.statusText}`,
			);
		}

		let data;

		try
		{
			data = JSON.parse(responseText);
		}
		catch (err)
		{
			console.error(
				"[KRATOS-ADMIN] Failed to parse JSON:",
				err,
			);

			throw new Error("Kratos returned invalid JSON");
		}

		console.log(
			"[KRATOS-ADMIN] Identities returned:",
			Array.isArray(data) ? data.length : "not an array",
		);

		if (!Array.isArray(data) || data.length === 0)
		{
			console.log("[KRATOS-ADMIN] Identity not found");

			return {
				first: null,
				last: null,
			};
		}

		const identity = data[0];

		console.log("[KRATOS-ADMIN] Identity found:", {
			id: identity?.id,
			email: identity?.traits?.email,
			name: identity?.traits?.name,
		});

		return {
			first: identity?.traits?.name?.first ?? null,
			last: identity?.traits?.name?.last ?? null,
		};
	}
	catch (err)
	{
		console.error(
			"[KRATOS-ADMIN] Unexpected error:",
			err,
		);

		throw err;
	}
}