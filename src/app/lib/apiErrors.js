export const jsonError = (message, status) =>
	Response.json({ success: false, error: message }, { status });

// Details stay in the server log; the client only learns that it failed.
export const internalError = () =>
	jsonError("Wewnętrzny błąd serwera", 500);

export const ORDER_LOCKED = "ORDER_LOCKED";

// 409 for an edit or delete the order no longer allows: an owner edit or delete
// of an order that is already shipped or completed, or any change of an order
// whose deletion is running. The client shows `message` and reloads the list.
export const orderLockedError = (message) =>
	Response.json({ success: false, code: ORDER_LOCKED, error: message }, { status: 409 });

export const FILE_BEING_ARCHIVED = "FILE_BEING_ARCHIVED";

// 409 for a rename of a file the archiver is replacing right now. Nothing was
// saved; the same edit succeeds once the archiver is done with the file.
export const fileBeingArchivedError = (message) =>
	Response.json({ success: false, code: FILE_BEING_ARCHIVED, error: message }, { status: 409 });
