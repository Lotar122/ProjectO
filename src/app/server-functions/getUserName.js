"use server";

export async function getNameFromEmail(email) {
	const res = await fetch(
		"http://localhost:4434/admin/identities?credentials_identifier=" +
			encodeURIComponent(email),
		{
			headers: {
				"Content-Type": "application/json",
			},
		},
	);

	if (!res.ok) {
		throw new Error("Kratos request failed: " + res.status);
	}

	const data = await res.json();

	if (!Array.isArray(data) || data.length === 0) {
		return { first: null, last: null };
	}

	const identity = data[0];

	return {
		first: identity?.traits?.name?.first || null,
		last: identity?.traits?.name?.last || null,
	};
}
