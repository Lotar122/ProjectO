import http from "@/app/lib/http";
import {
	KRATOS_PUBLIC,
	getKratosFlowMessages,
	getKratosNodeValue,
} from "@/app/lib/kratos";

const FALLBACK_ERROR_MESSAGE = "Podczas zmiany hasła wystąpił błąd.";

/**
 * Checks the change-password form before anything is sent to Kratos.
 * @param {{ currentPassword: string, newPassword: string, confirmPassword: string }} form
 * @returns {string | null} A message for the user, or null when the form is complete.
 */
export function validatePasswordChange(form)
{
	const { confirmPassword, currentPassword, newPassword } = form;

	if (!currentPassword || !newPassword || !confirmPassword)
	{
		return "Uzupełnij wszystkie pola hasła.";
	}

	if (newPassword !== confirmPassword)
	{
		return "Potwierdzenie nowego hasła jest niezgodne.";
	}

	return null;
}

/**
 * Turns a failed Kratos request into a message for the user.
 * @param {unknown} error
 * @returns {string}
 */
export function getPasswordChangeErrorMessage(error)
{
	const flowMessages = getKratosFlowMessages(error?.response?.data, "password");

	if (flowMessages.length > 0)
	{
		return flowMessages[0];
	}

	return (
		error?.response?.data?.error?.reason ||
		error?.response?.data?.error?.message ||
		error?.response?.data?.message ||
		error?.message ||
		FALLBACK_ERROR_MESSAGE
	);
}

/**
 * Re-verifies the session with the current password, then sets the new one
 * through the Kratos self-service settings flow. Rejects on any Kratos error.
 * @param {{ email: string, currentPassword: string, newPassword: string }} options
 * @returns {Promise<void>}
 */
export async function changeOwnPassword({ email, currentPassword, newPassword })
{
	if (typeof email !== "string" || !email)
	{
		throw new TypeError("changeOwnPassword: email must be a non-empty string.");
	}

	const refreshFlowResponse = await http.get(
		`${KRATOS_PUBLIC}/self-service/login/browser?refresh=true`,
		{ withCredentials: true },
	);

	await http.post(
		refreshFlowResponse.data.ui.action,
		{
			method: "password",
			identifier: email,
			password: currentPassword,
			csrf_token: getKratosNodeValue(refreshFlowResponse.data, "csrf_token"),
		},
		{ withCredentials: true },
	);

	const settingsFlowResponse = await http.get(
		`${KRATOS_PUBLIC}/self-service/settings/browser`,
		{ withCredentials: true },
	);

	await http.post(
		settingsFlowResponse.data.ui.action,
		{
			method: "password",
			password: newPassword,
			csrf_token: getKratosNodeValue(settingsFlowResponse.data, "csrf_token"),
		},
		{ withCredentials: true },
	);
}
