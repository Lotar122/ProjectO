"use client";

import { motion } from "framer-motion";
import { CheckCircle2, ShieldCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import axios from "axios";

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

		try
		{
			await axios.post(
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
			onCreated?.();
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
	};

	return (
		<motion.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.45 }}
			className="mx-auto max-w-3xl">
			<div className="overflow-hidden rounded-[28px] border border-slate-800 bg-slate-900/80 shadow-[0_24px_100px_rgba(0,0,0,0.35)] backdrop-blur-xl">
				<div className="border-b border-slate-800 bg-slate-950/70 px-6 py-5 sm:px-8">
					<div className="flex items-start gap-4">
						<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-slate-950">
							<UserPlus className="h-6 w-6" />
						</div>
						<div>
							<p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
								Panel administratora
							</p>
							<h2 className="text-2xl font-bold text-white">Dodaj użytkownika</h2>
							<p className="mt-2 max-w-xl text-sm text-slate-400">
								Utwórz nową tożsamość w Ory Kratos i nadaj jej odpowiednią rolę.
							</p>
						</div>
					</div>
				</div>

				<form onSubmit={handleSubmit} className="space-y-6 px-6 py-6 sm:px-8 sm:py-8">
					<div className="flex items-start gap-3 rounded-2xl border border-violet-400/15 bg-violet-400/8 px-4 py-4 text-sm text-violet-100">
						<ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
						<p>
							Adres e-mail będzie identyfikatorem logowania. Hasło przekaż użytkownikowi
							bezpiecznym kanałem.
						</p>
					</div>

					{errorMessage && (
						<motion.p
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300"
							role="alert">
							{errorMessage}
						</motion.p>
					)}

					{successMessage && (
						<motion.p
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							className="flex items-start gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
							role="status">
							<CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
							<span>{successMessage}</span>
						</motion.p>
					)}

					<div className="grid gap-5 md:grid-cols-2">
						<div className="md:col-span-2">
							<label htmlFor="identity-email" className="mb-2 block text-sm font-medium text-slate-300">
								Adres e-mail <span className="text-violet-300">*</span>
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
								className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-all duration-300 placeholder:text-slate-600 focus:border-violet-300/60 focus:ring-2 focus:ring-violet-200/20 focus:outline-none"
							/>
						</div>

						<div>
							<label htmlFor="identity-first-name" className="mb-2 block text-sm font-medium text-slate-300">
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
								className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-all duration-300 placeholder:text-slate-600 focus:border-violet-300/60 focus:ring-2 focus:ring-violet-200/20 focus:outline-none"
							/>
						</div>

						<div>
							<label htmlFor="identity-last-name" className="mb-2 block text-sm font-medium text-slate-300">
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
								className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-all duration-300 placeholder:text-slate-600 focus:border-violet-300/60 focus:ring-2 focus:ring-violet-200/20 focus:outline-none"
							/>
						</div>

						<div>
							<label htmlFor="identity-role" className="mb-2 block text-sm font-medium text-slate-300">
								Rola <span className="text-violet-300">*</span>
							</label>
							<select
								id="identity-role"
								name="role"
								required
								value={form.role}
								onChange={(event) => updateField("role", event.target.value)}
								className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-all duration-300 focus:border-violet-300/60 focus:ring-2 focus:ring-violet-200/20 focus:outline-none">
								<option value="user">Użytkownik</option>
								<option value="admin">Administrator</option>
							</select>
						</div>
					</div>

					<div className="grid gap-5 border-t border-slate-800 pt-6 md:grid-cols-2">
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

					<div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-6 sm:flex-row sm:justify-end">
						<button
							type="button"
							onClick={onCancel}
							className="rounded-xl border border-slate-700 px-5 py-3 font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white">
							Anuluj
						</button>
						<button
							type="submit"
							disabled={isSubmitting}
							className="flex items-center justify-center gap-2 rounded-xl bg-violet-100 px-5 py-3 font-semibold text-slate-950 transition-colors hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-70">
							<UserPlus className="h-4 w-4" />
							{isSubmitting ? "Tworzenie..." : "Utwórz użytkownika"}
						</button>
					</div>
				</form>
			</div>
		</motion.div>
	);
}
