"use client";

import http from "@/app/lib/http";
import { m } from "framer-motion";
import { Pencil, RefreshCw, Save, Trash2, UserCircle, X } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import Alert from "../../components/Alert";
import PasswordField from "../../components/passwordField";

const getIdentityName = (identity) =>
	[identity?.traits?.name?.first, identity?.traits?.name?.last].filter(Boolean).join(" ") ||
	"Bez imienia i nazwiska";

const FIELD_CLASS = "field mt-2";
const FIELD_LABEL_CLASS = "block text-sm font-medium text-foreground";

// Owns the form state so typing re-renders this form only, not the whole list.
const IdentityEditForm = memo(function IdentityEditForm({
	identity,
	onClearMessages,
	onClose,
	onError,
	onSaved,
})
{
	const [form, setForm] = useState(() => ({
		email: identity.traits?.email || "",
		firstName: identity.traits?.name?.first || "",
		lastName: identity.traits?.name?.last || "",
		role: identity.traits?.role === "admin" ? "admin" : "user",
		password: "",
	}));
	const [isSaving, setIsSaving] = useState(false);

	const updateField = (field, value) =>
	{
		setForm((current) => ({ ...current, [field]: value }));
		onClearMessages();
	};

	const saveIdentity = async (event) =>
	{
		event.preventDefault();
		setIsSaving(true);
		onClearMessages();

		try
		{
			const response = await http.put(
				"/api/admin/updateIdentity",
				{ id: identity.id, ...form, updatedAt: identity.updated_at },
				{ withCredentials: true },
			);
			setForm((current) => ({ ...current, password: "" }));
			onSaved(response.data.identity);
		}
		catch (error)
		{
			onError(error.response?.data?.error || "Nie udało się zapisać zmian.");
		}
		finally
		{
			setIsSaving(false);
		}
	};

	return (
		<form onSubmit={saveIdentity} className="space-y-5 border-t border-line bg-background p-5">
			<div className="flex items-center justify-between">
				<h3 className="font-semibold text-foreground">Edytuj konto</h3>
				<button type="button" onClick={onClose} className="btn btn-ghost -my-1.5 -mr-1.5 size-10 min-h-0 px-0" aria-label="Zamknij edycję">
					<X className="h-5 w-5" aria-hidden="true" />
				</button>
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<label className={FIELD_LABEL_CLASS}>
					Adres e-mail
					<input type="email" required value={form.email} onChange={(event) => updateField("email", event.target.value)} className={FIELD_CLASS} />
				</label>
				<label className={FIELD_LABEL_CLASS}>
					Rola
					<select value={form.role} onChange={(event) => updateField("role", event.target.value)} className={FIELD_CLASS}>
						<option value="user">Użytkownik</option>
						<option value="admin">Administrator</option>
					</select>
				</label>
				<label className={FIELD_LABEL_CLASS}>
					Imię
					<input type="text" value={form.firstName} onChange={(event) => updateField("firstName", event.target.value)} className={FIELD_CLASS} />
				</label>
				<label className={FIELD_LABEL_CLASS}>
					Nazwisko
					<input type="text" value={form.lastName} onChange={(event) => updateField("lastName", event.target.value)} className={FIELD_CLASS} />
				</label>
			</div>
			<div className="max-w-md">
				<PasswordField id={`identity-password-${identity.id}`} name="password" label="Nowe hasło (opcjonalnie)" autoComplete="new-password" password={form.password} placeholder="Pozostaw puste, aby nie zmieniać" required={false} setPassword={(value) => updateField("password", value)} />
			</div>
			<div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:justify-end">
				<button type="button" onClick={onClose} className="btn btn-secondary px-5">Anuluj</button>
				<button type="submit" disabled={isSaving} className="btn btn-primary px-5">
					<Save className="h-4 w-4" aria-hidden="true" />
					{isSaving ? "Zapisywanie..." : "Zapisz zmiany"}
				</button>
			</div>
		</form>
	);
});

const IdentityRow = memo(function IdentityRow({
	identity,
	isDeleting,
	isEditing,
	onClearMessages,
	onDelete,
	onError,
	onSaved,
	onStartEditing,
	onStopEditing,
})
{
	return (
		<div className="overflow-hidden rounded-xl border border-line bg-surface">
			<div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 items-center gap-4">
					<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-muted">
						<UserCircle className="h-6 w-6" aria-hidden="true" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="min-w-0 max-w-full truncate font-semibold text-foreground">{getIdentityName(identity)}</h3>
							<span className={`rounded-full px-2.5 py-1 text-xs font-medium ${identity.traits?.role === "admin" ? "bg-accent-soft text-accent-text" : "bg-surface-raised text-muted"}`}>
								{identity.traits?.role === "admin" ? "Administrator" : "Użytkownik"}
							</span>
						</div>
						<p className="truncate text-sm text-muted">{identity.traits?.email}</p>
					</div>
				</div>
				<div className="flex shrink-0 gap-2">
					<button type="button" onClick={() => onStartEditing(identity)} className="btn btn-secondary">
						<Pencil className="h-4 w-4" aria-hidden="true" />
						Edytuj
					</button>
					<button type="button" onClick={() => onDelete(identity)} disabled={isDeleting} className="btn btn-danger">
						<Trash2 className="h-4 w-4" aria-hidden="true" />
						{isDeleting ? "Usuwanie..." : "Usuń"}
					</button>
				</div>
			</div>

			{isEditing && (
				<IdentityEditForm
					identity={identity}
					onClearMessages={onClearMessages}
					onClose={onStopEditing}
					onError={onError}
					onSaved={onSaved} />
			)}
		</div>
	);
});

export default function ManageUsers({ refreshToken, onUserAction })
{
	// null until the first response; the spinner is only for that case.
	const [identities, setIdentities] = useState(null);
	const [editingId, setEditingId] = useState(null);
	const [isLoading, setIsLoading] = useState(true);
	const [deletingId, setDeletingId] = useState(null);
	const [errorMessage, setErrorMessage] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() =>
	{
		const controller = new AbortController();

		const loadIdentities = async () =>
		{
			try
			{
				const response = await http.get("/api/admin/getIdentities", {
					withCredentials: true,
					signal: controller.signal,
				});

				if (!controller.signal.aborted)
				{
					setIdentities(response.data.identities || []);
				}
			}
			catch (error)
			{
				// Superseded by a newer request or unmounted: nothing to report.
				if (!controller.signal.aborted)
				{
					setErrorMessage(error.response?.data?.error || "Nie udało się pobrać użytkowników.");
				}
			}
			finally
			{
				if (!controller.signal.aborted)
				{
					setIsLoading(false);
				}
			}
		};

		void loadIdentities();

		return () =>
		{
			controller.abort();
		};
	}, [refreshToken, reloadKey]);

	const refreshIdentities = useCallback(() =>
	{
		onUserAction?.();
		setIsLoading(true);
		setErrorMessage("");
		setReloadKey((value) => value + 1);
	}, [onUserAction]);

	const clearMessages = useCallback(() =>
	{
		onUserAction?.();
		setErrorMessage("");
		setSuccessMessage("");
	}, [onUserAction]);

	const startEditing = useCallback((identity) =>
	{
		setEditingId(identity.id);
		clearMessages();
	}, [clearMessages]);

	const stopEditing = useCallback(() =>
	{
		setEditingId(null);
	}, []);

	const handleSaved = useCallback((updated) =>
	{
		setIdentities((current) =>
			current.map((identity) => (identity.id === updated.id ? updated : identity)),
		);
		setSuccessMessage("Dane użytkownika zostały zapisane.");
	}, []);

	const deleteIdentity = useCallback(async (identity) =>
	{
		if (!window.confirm(`Czy na pewno usunąć konto ${identity.traits?.email || "użytkownika"}?`))
		{
			return;
		}

		setDeletingId(identity.id);
		clearMessages();

		try
		{
			await http.delete(`/api/admin/deleteIdentity?id=${encodeURIComponent(identity.id)}`, {
				withCredentials: true,
			});
			setIdentities((current) => current.filter((item) => item.id !== identity.id));
			setEditingId((current) => (current === identity.id ? null : current));
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
	}, [clearMessages]);

	return (
		<m.section
			initial={{ opacity: 0, y: 18 }}
			animate={{ opacity: 1, y: 0 }}
			className="space-y-5">
			<div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center">
				<div>
					<h2 className="text-lg font-semibold text-foreground">Konta użytkowników</h2>
					<p className="mt-1 text-sm text-muted">{identities?.length ?? 0} kont w systemie</p>
				</div>
				<button
					type="button"
					onClick={refreshIdentities}
					disabled={isLoading}
					className="btn btn-secondary">
					<RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden="true" />
					Odśwież
				</button>
			</div>

			{errorMessage && <Alert tone="danger">{errorMessage}</Alert>}
			{successMessage && <Alert tone="success">{successMessage}</Alert>}

			{isLoading && identities === null ? (
				<div className="rounded-xl border border-line bg-surface px-6 py-12 text-center text-sm text-muted">Wczytywanie użytkowników...</div>
			) : !identities?.length ? (
				<div className="rounded-xl border border-dashed border-line-control bg-surface px-6 py-12 text-center text-muted">Nie znaleziono użytkowników.</div>
			) : (
				<div className="grid gap-4">
					{identities.map((identity) =>
						<IdentityRow
							key={identity.id}
							identity={identity}
							isDeleting={deletingId === identity.id}
							isEditing={editingId === identity.id}
							onClearMessages={clearMessages}
							onDelete={deleteIdentity}
							onError={setErrorMessage}
							onSaved={handleSaved}
							onStartEditing={startEditing}
							onStopEditing={stopEditing} />,
					)}
				</div>
			)}
		</m.section>
	);
}
