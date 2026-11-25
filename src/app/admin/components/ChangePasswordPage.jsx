"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import AdminPageHeader from "./AdminPageHeader";
import PasswordSettingsForm from "../../orders/components/PasswordSettingsForm";
import {
	changeOwnPassword,
	getPasswordChangeErrorMessage,
	validatePasswordChange,
} from "@/app/lib/changePassword";

const INITIAL_FORM = {
	currentPassword: "",
	newPassword: "",
	confirmPassword: "",
};

export default function ChangePasswordPage({ returnPath, userEmail })
{
	const router = useRouter();
	const [form, setForm] = useState(INITIAL_FORM);
	const [errorMessage, setErrorMessage] = useState(null);
	const [successMessage, setSuccessMessage] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const updateField = (field, value) =>
	{
		setForm((current) => ({ ...current, [field]: value }));
		setSuccessMessage("");
	};

	const handleSubmit = async (event) =>
	{
		event.preventDefault();

		if (isSubmitting)
		{
			return;
		}

		const validationError = validatePasswordChange(form);

		if (validationError)
		{
			setErrorMessage(validationError);
			return;
		}

		setIsSubmitting(true);
		setErrorMessage(null);
		setSuccessMessage("");

		try
		{
			await changeOwnPassword({
				email: userEmail,
				currentPassword: form.currentPassword,
				newPassword: form.newPassword,
			});
			setForm(INITIAL_FORM);
			setSuccessMessage("Hasło zostało zmienione. Użyj go przy następnym logowaniu.");
		}
		catch (error)
		{
			console.error("Nie udało się zmienić hasła:", error);
			setErrorMessage(getPasswordChangeErrorMessage(error));
		}
		finally
		{
			setIsSubmitting(false);
		}
	};

	return (
		<>
			<AdminPageHeader
				title="Zmień hasło"
				description="Najpierw potwierdź obecne hasło, a następnie ustaw nowe hasło."
			/>
			<PasswordSettingsForm
				confirmPassword={form.confirmPassword}
				currentPassword={form.currentPassword}
				errorMessage={errorMessage}
				hideHeader
				isSubmitting={isSubmitting}
				newPassword={form.newPassword}
				onCancel={() => router.push(returnPath)}
				onConfirmPasswordChange={(value) => updateField("confirmPassword", value)}
				onCurrentPasswordChange={(value) => updateField("currentPassword", value)}
				onNewPasswordChange={(value) => updateField("newPassword", value)}
				onSubmit={handleSubmit}
				successMessage={successMessage}
			/>
		</>
	);
}
