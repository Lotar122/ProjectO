import "server-only";

// The whoami session already carries the identity traits, so the name is read
// from there instead of a second request to the Kratos admin API.
export function getIdentityName(identity)
{
	return {
		first: identity?.traits?.name?.first ?? null,
		last: identity?.traits?.name?.last ?? null,
	};
}
