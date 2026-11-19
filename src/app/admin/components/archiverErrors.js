import { isAbortError } from "../../lib/http.js";

const MESSAGES = {
	forbidden: "Brak uprawnień administratora.",
	conflict: "Archiwizacja jest już uruchomiona.",
	unreachable: "Nie udało się połączyć z serwerem. Spróbuj ponownie.",
	status: "Nie udało się pobrać statusu archiwizacji.",
	start: "Nie udało się uruchomić archiwizacji.",
};

/**
 * Maps a failed archiver request to Polish UI text. The server text is never shown.
 * @param {unknown} err Error thrown by the http wrapper.
 * @param {"status" | "start"} action Request that failed, picks the fallback text.
 * @returns {string}
 */
export function getArchiverErrorText(err, action)
{
	if (action !== "status" && action !== "start")
	{
		throw new TypeError(`Unknown archiver action: ${String(action)}`);
	}

	const status = err?.response?.status;

	if (status === 403)
	{
		return MESSAGES.forbidden;
	}

	if (status === 409)
	{
		return MESSAGES.conflict;
	}

	if (!err?.response || isAbortError(err))
	{
		return MESSAGES.unreachable;
	}

	return MESSAGES[action];
}
