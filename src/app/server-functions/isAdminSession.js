// The role lives in metadata_public: readable through whoami, but writable
// only with the Kratos admin API. Identity traits can be edited by the user
// themselves through the self-service settings flow, so they are never trusted.
export function isAdminSession(userAuthSession)
{
	return (
		userAuthSession?.loggedIn === true &&
		userAuthSession.data?.identity?.metadata_public?.role === "admin"
	);
}
