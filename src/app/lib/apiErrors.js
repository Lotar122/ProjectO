export const jsonError = (message, status) =>
	Response.json({ success: false, error: message }, { status });

// Details stay in the server log; the client only learns that it failed.
export const internalError = () =>
	jsonError("Wewnętrzny błąd serwera", 500);
