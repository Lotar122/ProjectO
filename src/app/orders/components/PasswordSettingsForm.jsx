"use client";

import { m } from "framer-motion";
import { KeyRound, ShieldCheck } from "lucide-react";

import Alert from "@/app/components/Alert";
import { SECTION_ENTER } from "@/app/components/motion";
import PasswordField from "@/app/components/passwordField";

export default function PasswordSettingsForm({
	confirmPassword,
	currentPassword,
	errorMessage,
	hideHeader = false,
	isSubmitting,
	newPassword,
	onCancel,
	onConfirmPasswordChange,
	onCurrentPasswordChange,
	onNewPasswordChange,
	onSubmit,
	successMessage,
})
{
	return (
		<m.div
			{...SECTION_ENTER}
			className={hideHeader ? "max-w-2xl" : "mx-auto max-w-2xl"}>
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				{!hideHeader && <div className="border-b border-line bg-surface-raised px-5 py-5 sm:px-8">
					<div className="flex items-start gap-3 sm:gap-4">
						<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-contrast">
							<KeyRound className="h-6 w-6" aria-hidden="true" />
						</div>
						<div className="min-w-0">
							<h2 className="text-2xl font-bold text-foreground">Zmień hasło</h2>
							<p className="mt-2 max-w-xl text-sm text-muted">
								Najpierw potwierdź obecne hasło, a następnie ustaw nowe hasło do
								konta.
							</p>
						</div>
					</div>
				</div>}

				<form onSubmit={onSubmit} className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
					<Alert tone="info" icon={ShieldCheck} announce={false}>
						Przed zmianą hasła sesja zostanie ponownie zweryfikowana.
					</Alert>

					{successMessage && <Alert tone="success">{successMessage}</Alert>}

					{errorMessage && <Alert tone="danger">{errorMessage}</Alert>}

					<PasswordField
						autoComplete="current-password"
						id="current-password"
						label="Obecne hasło"
						name="current-password"
						password={currentPassword}
						placeholder="Wpisz obecne hasło"
						setPassword={onCurrentPasswordChange}
					/>

					<PasswordField
						autoComplete="new-password"
						id="new-password"
						label="Nowe hasło"
						hint="Co najmniej 8 znaków."
						name="new-password"
						password={newPassword}
						placeholder="Wybierz nowe hasło"
						setPassword={onNewPasswordChange}
					/>

					<PasswordField
						autoComplete="new-password"
						id="confirm-password"
						label="Potwierdź nowe hasło"
						name="confirm-password"
						password={confirmPassword}
						placeholder="Powtórz nowe hasło"
						setPassword={onConfirmPasswordChange}
					/>

					<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
						<button type="button" onClick={onCancel} className="btn btn-secondary px-5">
							Anuluj
						</button>
						<button type="submit" disabled={isSubmitting} className="btn btn-primary px-5">
							{isSubmitting ? "Zapisywanie..." : "Zmień hasło"}
						</button>
					</div>
				</form>
			</div>
		</m.div>
	);
}
