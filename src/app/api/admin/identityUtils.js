export const sanitizeIdentity = (identity) => ({
	id: identity.id,
	traits: {
		email: identity.traits?.email || "",
		role: identity.metadata_public?.role === "admin" ? "admin" : "user",
		name: {
			first: identity.traits?.name?.first || "",
			last: identity.traits?.name?.last || "",
		},
	},
	created_at: identity.created_at,
	updated_at: identity.updated_at,
});
