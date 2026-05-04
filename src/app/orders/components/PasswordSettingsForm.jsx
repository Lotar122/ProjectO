"use client";

import { motion } from "framer-motion";
import { KeyRound, ShieldCheck } from "lucide-react";

import PasswordField from "@/app/components/passwordField";

export default function PasswordSettingsForm({
	confirmPassword,
	currentPassword,
	errorMessage,
	isSubmitting,
	newPassword,
	onCancel,
	onConfirmPasswordChange,
	onCurrentPasswordChange,
	onNewPasswordChange,
	onSubmit,
})
{
	return (
		<motion.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.45 }}
			className="mx-auto max-w-2xl">
			<div className="overflow-hidden rounded-[28px] border border-slate-800 bg-slate-900/80 shadow-[0_24px_100px_rgba(0,0,0,0.35)] backdrop-blur-xl">
				<div className="border-b border-slate-800 bg-slate-950/70 px-6 py-5 sm:px-8">
					<div className="flex items-start gap-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-100 text-slate-950">
							<KeyRound className="h-6 w-6" />
						</div>
						<div>
							<h2 className="text-2xl font-bold text-white">Change Password</h2>
							<p className="mt-2 max-w-xl text-sm text-slate-400">
								Confirm your current password first, then choose a new one for
								your Ory account.
							</p>
						</div>
					</div>
				</div>

				<form onSubmit={onSubmit} className="space-y-6 px-6 py-6 sm:px-8 sm:py-8">
					<div className="rounded-2xl border border-sky-400/15 bg-sky-400/8 px-4 py-4 text-sm text-sky-100">
						<div className="flex items-start gap-3">
							<ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
							<p>
								Your session will be re-verified with Ory before the password is
								updated.
							</p>
						</div>
					</div>

					{errorMessage && (
						<motion.p
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
							{errorMessage}
						</motion.p>
					)}

					<PasswordField
						autoComplete="current-password"
						label="Current Password"
						password={currentPassword}
						placeholder="Enter your current password"
						setPassword={onCurrentPasswordChange}
					/>

					<PasswordField
						autoComplete="new-password"
						label="New Password"
						password={newPassword}
						placeholder="Choose a new password"
						setPassword={onNewPasswordChange}
					/>

					<PasswordField
						autoComplete="new-password"
						label="Confirm New Password"
						password={confirmPassword}
						placeholder="Repeat your new password"
						setPassword={onConfirmPasswordChange}
					/>

					<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
						<button
							type="button"
							onClick={onCancel}
							className="rounded-xl border border-slate-700 px-5 py-3 font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white">
							Cancel
						</button>
						<button
							type="submit"
							disabled={isSubmitting}
							className="rounded-xl bg-sky-100 px-5 py-3 font-semibold text-slate-950 transition-colors hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70">
							{isSubmitting ? "Updating..." : "Update Password"}
						</button>
					</div>
				</form>
			</div>
		</motion.div>
	);
}
