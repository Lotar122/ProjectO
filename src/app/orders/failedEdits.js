/**
 * Keeps an order edit whose save failed, so reopening that order's edit form
 * restores the draft and the selected scans. One entry per order; a newer
 * failure replaces the older one.
 * @param {Map<string, { order: object, draft: object, files: object[] }>} store
 * @param {string} orderId
 * @param {{ order: object, draft: object, files: object[] }} edit
 */
export const rememberFailedEdit = (store, orderId, edit) =>
{
	if (!(store instanceof Map))
	{
		throw new TypeError("rememberFailedEdit expects a Map.");
	}

	store.set(orderId, edit);
};

const SERVER_FIELDS = ["updatedAt", "updated_at", "patient", "details", "type", "status", "due_date", "dueDate"];

const sameFiles = (first, second) =>
{
	const a = Array.isArray(first) ? first : [];
	const b = Array.isArray(second) ? second : [];

	return a.length === b.length && a.every((fileId, index) => fileId === b[index]);
};

/**
 * True when the order's server data differs from the order the failed edit started from
 * (file list, update time or edited fields). That happens when the failed save actually
 * committed (a client timeout) or someone else edited the order; restoring the draft
 * would then upload its scans again or overwrite newer data.
 * @param {{ order: object }} edit
 * @param {object} currentOrder
 * @returns {boolean}
 */
export const isFailedEditStale = (edit, currentOrder) =>
{
	if (!edit?.order || !currentOrder)
	{
		throw new TypeError("isFailedEditStale expects an edit and the current order.");
	}

	return !sameFiles(edit.order.files, currentOrder.files)
		|| SERVER_FIELDS.some((field) => (edit.order[field] ?? null) !== (currentOrder[field] ?? null));
};

/**
 * Returns the failed edit saved for the order and removes it, so it is restored
 * once and a later edit starts clean. With currentOrder, an edit that is stale
 * against it is dropped and null is returned.
 * @param {Map<string, { order: object, draft: object, files: object[] }>} store
 * @param {string} orderId
 * @param {object} [currentOrder]
 * @returns {{ order: object, draft: object, files: object[] } | null}
 */
export const takeFailedEdit = (store, orderId, currentOrder) =>
{
	if (!(store instanceof Map))
	{
		throw new TypeError("takeFailedEdit expects a Map.");
	}

	const edit = store.get(orderId) ?? null;

	store.delete(orderId);

	if (edit && currentOrder && isFailedEditStale(edit, currentOrder))
	{
		return null;
	}

	return edit;
};

/**
 * Forgets the failed edit saved for the order, if any.
 * @param {Map<string, object>} store
 * @param {string} orderId
 * @returns {boolean} Whether an edit was removed.
 */
export const discardFailedEdit = (store, orderId) =>
{
	if (!(store instanceof Map))
	{
		throw new TypeError("discardFailedEdit expects a Map.");
	}

	return store.delete(orderId);
};
