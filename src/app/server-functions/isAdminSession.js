export function isAdminSession(userAuthSession)
{
	return (
		userAuthSession?.loggedIn === true &&
		userAuthSession.data?.identity?.traits?.role === "admin"
	);
}
