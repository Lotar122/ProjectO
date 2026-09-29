"use client";

import axios from "axios";
import { motion } from "framer-motion";
import { Pencil, RefreshCw, Save, Trash2, UserCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import PasswordField from "../../components/passwordField";

const EMPTY_FORM = {
	email: "",
	firstName: "",
	lastName: "",
	role: "user",
	password: "",
};

const getIdentityName = (identity) =>
	[identity?.traits?.name?.first, identity?.traits?.name?.last].filter(Boolean).join(" ") ||
	"Bez imienia i nazwiska";

export default function ManageUsers({ refreshToken })
{
	const [identities, setIdentities] = useState([]);
	const [editingId, setEditingId] = useState(null);
	const [form, setForm] = useState(EMPTY_FORM);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const [deletingId, setDeletingId] = useState(null);
	const [errorMessage, setErrorMessage] = useState("");
	const [successMessage, setSuccessMessage] = useState("");

	const loadIdentities = useCallback(async () =>
	{
		setIsLoading(true);
		setErrorMessage("");

		try
		{
			const response = await axios.get("/api/admin/getIdentities", {
				withCredentials: true,
			});
			setIdentities(response.data.identities || []);
		}
		catch (error)
		{
			setErrorMessage(error.response?.data?.error || "Nie udało się pobrać użytkowników.");
		}
		finally
		{
			setIsLoading(false);
		}
	}, []);

	useEffect(() =>
	{
		void loadIdentities();
	}, [loadIdentities, refreshToken]);

	const startEditing = (identity) =>
	{
		setEditingId(identity.id);
		setForm({
			email: identity.traits?.email || "",
			firstName: identity.traits?.name?.first || "",
			lastName: identity.traits?.name?.last || "",
			role: identity.traits?.role === "admin" ? "admin" : "user",
			password: "",
		});
		setErrorMessage("");
		setSuccessMessage("");
	};

	const stopEditing = () =>
	{
		setEditingId(null);
		setForm(EMPTY_FORM);
	};

	const updateField = (field, value) =>
	{
		setForm((current) => ({ ...current, [field]: value }));
		setErrorMessage("");
		setSuccessMessage("");
	};

	const saveIdentity = async (event) =>
	{
		event.preventDefault();
		setIsSaving(true);
		setErrorMessage("");
		setSuccessMessage("");

		try
		{
			const response = await axios.put(
				"/api/admin/updateIdentity",
				{ id: editingId, ...form },
				{ withCredentials: true },
			);
			setIdentities((current) =>
				current.map((identity) =>
					identity.id === editingId ? response.data.identity : identity,
				),
			);
			setForm((current) => ({ ...current, password: "" }));
			setSuccessMessage("Dane użytkownika zostały zapisane.");
		}
		catch (error)
		{
			setErrorMessage(error.response?.data?.error || "Nie udało się zapisać zmian.");
		}
		finally
		{
			setIsSaving(false);
		}
	};

	const deleteIdentity = async (identity) =>
	{
		if (!window.confirm(`Czy na pewno usunąć konto ${identity.traits?.email || "użytkownika"}?`))
		{
			return;
		}

		setDeletingId(identity.id);
		setErrorMessage("");
		setSuccessMessage("");

		try
		{
			await axios.delete(`/api/admin/deleteIdentity?id=${encodeURIComponent(identity.id)}`, {
				withCredentials: true,
			});
			setIdentities((current) => current.filter((item) => item.id !== identity.id));
			if (editingId === identity.id)
			{
				stopEditing();
			}
			setSuccessMessage("Konto zostało usunięte.");
		}
		catch (error)
		{
			setErrorMessage(error.response?.data?.error || "Nie udało się usunąć konta.");
		}
		finally
		{
			setDeletingId(null);
		}
	};

	return (
		<motion.section
			initial={{ opacity: 0, y: 18 }}
			animate={{ opacity: 1, y: 0 }}
			className="space-y-5">
			<div className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/65 px-5 py-4 sm:flex-row sm:items-center">
				<div>
					<h3 className="text-lg font-semibold text-white">Konta użytkowników</h3>
					<p className="mt-1 text-sm text-slate-400">{identities.length} kont w systemie</p>
				</div>
				<button
					type="button"
					onClick={() => void loadIdentities()}
					disabled={isLoading}
					className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50">
					<RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
					Odśwież
				</button>
			</div>

			{errorMessage && <p className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">{errorMessage}</p>}
			{successMessage && <p className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300" role="status">{successMessage}</p>}

			{isLoading ? (
				<div className="rounded-2xl border border-slate-800 bg-slate-900/65 px-6 py-12 text-center text-sm text-slate-400">Wczytywanie użytkowników...</div>
			) : identities.length === 0 ? (
				<div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/55 px-6 py-12 text-center text-slate-400">Nie znaleziono użytkowników.</div>
			) : (
				<div className="grid gap-4">
					{identities.map((identity) =>
						<div key={identity.id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/65">
							<div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex min-w-0 items-center gap-4">
									<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-300"><UserCircle className="h-6 w-6" /></div>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<h4 className="truncate font-semibold text-white">{getIdentityName(identity)}</h4>
											<span className={`rounded-full px-2.5 py-1 text-xs font-medium ${identity.traits?.role === "admin" ? "bg-violet-400/15 text-violet-200" : "bg-slate-800 text-slate-300"}`}>{identity.traits?.role === "admin" ? "Administrator" : "Użytkownik"}</span>
										</div>
										<p className="truncate text-sm text-slate-400">{identity.traits?.email}</p>
									</div>
								</div>
								<div className="flex shrink-0 gap-2">
									<button type="button" onClick={() => startEditing(identity)} className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white"><Pencil className="h-4 w-4" />Edytuj</button>
									<button type="button" onClick={() => void deleteIdentity(identity)} disabled={deletingId === identity.id} className="flex items-center gap-2 rounded-xl border border-red-500/25 px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"><Trash2 className="h-4 w-4" />{deletingId === identity.id ? "Usuwanie..." : "Usuń"}</button>
								</div>
							</div>

							{editingId === identity.id && (
								<form onSubmit={saveIdentity} className="space-y-5 border-t border-slate-800 bg-slate-950/45 p-5">
									<div className="flex items-center justify-between"><h4 className="font-semibold text-white">Edytuj konto</h4><button type="button" onClick={stopEditing} className="rounded-lg p-1 text-slate-400 hover:text-white" aria-label="Zamknij edycję"><X className="h-5 w-5" /></button></div>
									<div className="grid gap-4 md:grid-cols-2">
										<label className="text-sm text-slate-300">Adres e-mail<input type="email" required value={form.email} onChange={(event) => updateField("email", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white focus:border-violet-300/60 focus:outline-none" /></label>
										<label className="text-sm text-slate-300">Rola<select value={form.role} onChange={(event) => updateField("role", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white focus:border-violet-300/60 focus:outline-none"><option value="user">Użytkownik</option><option value="admin">Administrator</option></select></label>
										<label className="text-sm text-slate-300">Imię<input type="text" value={form.firstName} onChange={(event) => updateField("firstName", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white focus:border-violet-300/60 focus:outline-none" /></label>
										<label className="text-sm text-slate-300">Nazwisko<input type="text" value={form.lastName} onChange={(event) => updateField("lastName", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white focus:border-violet-300/60 focus:outline-none" /></label>
									</div>
									<div className="max-w-md"><PasswordField id={`identity-password-${identity.id}`} name="password" label="Nowe hasło (opcjonalnie)" autoComplete="new-password" password={form.password} placeholder="Pozostaw puste, aby nie zmieniać" setPassword={(value) => updateField("password", value)} /></div>
									<div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:justify-end"><button type="button" onClick={stopEditing} className="rounded-xl border border-slate-700 px-5 py-3 font-medium text-slate-200 hover:border-slate-500 hover:text-white">Anuluj</button><button type="submit" disabled={isSaving} className="flex items-center justify-center gap-2 rounded-xl bg-violet-100 px-5 py-3 font-semibold text-slate-950 hover:bg-violet-200 disabled:opacity-60"><Save className="h-4 w-4" />{isSaving ? "Zapisywanie..." : "Zapisz zmiany"}</button></div>
								</form>
							)}
						</div>,
					)}
				</div>
			)}
		</motion.section>
	);
}
