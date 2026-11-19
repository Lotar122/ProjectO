export const jsonError = (message, status) =>
	Response.json({ success: false, error: message }, { status });

// Details stay in the server log; the client only learns that it failed.
export const internalError = () =>
	jsonError("Wewnętrzny błąd serwera", 500);

export const ORDER_LOCKED = "ORDER_LOCKED";

// 409 for an owner edit or delete of an order that is already shipped or completed.
export const orderLockedError = (message) =>
	Response.json({ success: false, code: ORDER_LOCKED, error: message }, { status: 409 });
