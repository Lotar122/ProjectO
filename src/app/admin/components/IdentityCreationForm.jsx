"use client";

import { m } from "framer-motion";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import http from "@/app/lib/http";

import Alert from "@/app/components/Alert";
import PasswordField from "@/app/components/passwordField";

const INITIAL_FORM = {
	email: "",
	firstName: "",
	lastName: "",
	role: "user",
	password: "",
	confirmPassword: "",
};

export default function IdentityCreationForm({ onCancel, onCreated })
{
	const [form, setForm] = useState(INITIAL_FORM);
	const [errorMessage, setErrorMessage] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const updateField = (field, value) =>
	{
		setForm((current) => ({ ...current, [field]: value }));
		setErrorMessage("");
		setSuccessMessage("");
	};

	const handleSubmit = async (event) =>
	{
		event.preventDefault();

		if (form.password !== form.confirmPassword)
		{
			setErrorMessage("Hasła muszą być identyczne.");
			return;
		}

		if (form.password.length < 8)
		{
			setErrorMessage("Hasło musi mieć co najmniej 8 znaków.");
			return;
		}

		setIsSubmitting(true);
		setErrorMessage("");
		setSuccessMessage("");

		let created = false;

		try
		{
			await http.post(
				"/api/admin/createIdentity",
				{
					email: form.email,
					firstName: form.firstName,
					lastName: form.lastName,
					role: form.role,
					password: form.password,
				},
				{ withCredentials: true },
			);

			setForm(INITIAL_FORM);
			setSuccessMessage("Tożsamość została utworzona. Użytkownik może się teraz zalogować.");
			created = true;
		}
		catch (error)
		{
			setErrorMessage(
				error.response?.data?.error ||
					"Nie udało się utworzyć użytkownika. Spróbuj ponownie.",
			);
		}
		finally
		{
			setIsSubmitting(false);
		}

		if (created)
		{
			onCreated?.();
		}
	};

	return (
		<m.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.45 }}
			className="max-w-3xl">
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				<form onSubmit={handleSubmit} className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
					<Alert tone="info" icon={ShieldCheck} announce={false}>
						Adres e-mail będzie identyfikatorem logowania. Hasło przekaż użytkownikowi
						bezpiecznym kanałem.
					</Alert>

					{errorMessage && <Alert tone="danger">{errorMessage}</Alert>}

					{successMessage && <Alert tone="success">{successMessage}</Alert>}

					<div className="grid gap-5 md:grid-cols-2">
						<div className="md:col-span-2">
							<label htmlFor="identity-email" className="field-label">
								Adres e-mail <span className="text-accent-text" aria-hidden="true">*</span>
							</label>
							<input
								type="email"
								id="identity-email"
								name="email"
								autoComplete="email"
								required
								value={form.email}
								onChange={(event) => updateField("email", event.target.value)}
								placeholder="uzytkownik@przyklad.pl"
								className="field"
							/>
						</div>

						<div>
							<label htmlFor="identity-first-name" className="field-label">
								Imię
							</label>
							<input
								type="text"
								id="identity-first-name"
								name="firstName"
								autoComplete="given-name"
								value={form.firstName}
								onChange={(event) => updateField("firstName", event.target.value)}
								placeholder="Jan"
								className="field"
							/>
						</div>

						<div>
							<label htmlFor="identity-last-name" className="field-label">
								Nazwisko
							</label>
							<input
								type="text"
								id="identity-last-name"
								name="lastName"
								autoComplete="family-name"
								value={form.lastName}
								onChange={(event) => updateField("lastName", event.target.value)}
								placeholder="Kowalski"
								className="field"
							/>
						</div>

						<div>
							<label htmlFor="identity-role" className="field-label">
								Rola <span className="text-accent-text" aria-hidden="true">*</span>
							</label>
							<select
								id="identity-role"
								name="role"
								required
								value={form.role}
								onChange={(event) => updateField("role", event.target.value)}
								className="field">
								<option value="user">Użytkownik</option>
								<option value="admin">Administrator</option>
							</select>
						</div>
					</div>

					<div className="grid gap-5 border-t border-line pt-6 md:grid-cols-2">
						<PasswordField
							id="identity-password"
							name="password"
							label="Hasło początkowe"
							autoComplete="new-password"
							password={form.password}
							placeholder="Minimum 8 znaków"
							setPassword={(value) => updateField("password", value)}
						/>
						<PasswordField
							id="identity-confirm-password"
							name="confirmPassword"
							label="Powtórz hasło"
							autoComplete="new-password"
							password={form.confirmPassword}
							placeholder="Wpisz hasło ponownie"
							setPassword={(value) => updateField("confirmPassword", value)}
						/>
					</div>

					<div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:justify-end">
						<button
							type="button"
							onClick={onCancel}
							className="btn btn-secondary px-5">
							Anuluj
						</button>
						<button
							type="submit"
							disabled={isSubmitting}
							className="btn btn-primary px-5">
							<UserPlus className="h-4 w-4" aria-hidden="true" />
							{isSubmitting ? "Tworzenie..." : "Utwórz użytkownika"}
						</button>
					</div>
				</form>
			</div>
		</m.div>
	);
}
