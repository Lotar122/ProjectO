"use client";

import http from "@/app/lib/http";
import { Check, CircleAlert, Pencil, Plus, RotateCw, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import Alert from "../../components/Alert";

const API_URL = "/api/admin/orderingParties";
const MAX_NAME_LENGTH = 200;
const DANGER_HOVER = "enabled:hover:border-danger-line enabled:hover:bg-danger-soft enabled:hover:text-danger-text enabled:active:bg-danger-soft";

const sortByName = (parties) => [...parties].sort((a, b) => a.name.localeCompare(b.name, "pl"));

function RowError({ message })
{
	if (!message)
	{
		return null;
	}

	return (
		<p role="alert" className="flex items-start gap-2 pb-3 text-sm text-danger-text">
			<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<span className="min-w-0 wrap-break-word">{message}</span>
		</p>
	);
}

const OrderingPartyRow = memo(function OrderingPartyRow({
	party,
	errorMessage,
	isBusy,
	onDelete,
	onRename,
})
{
	const [mode, setMode] = useState("view");
	const [draft, setDraft] = useState(party.name);
	const editButtonRef = useRef(null);
	const deleteButtonRef = useRef(null);
	const confirmButtonRef = useRef(null);
	// Which at-rest button to refocus when the row returns to view mode.
	const returnFocusTo = useRef(null);

	useEffect(() =>
	{
		if (mode === "delete")
		{
			confirmButtonRef.current?.focus();
		}
		else if (mode === "view" && returnFocusTo.current)
		{
			const button = returnFocusTo.current === "edit" ? editButtonRef.current : deleteButtonRef.current;
			returnFocusTo.current = null;
			button?.focus();
		}
	}, [mode]);

	const startEditing = () =>
	{
		returnFocusTo.current = "edit";
		setDraft(party.name);
		setMode("edit");
	};

	const startDeleting = () =>
	{
		returnFocusTo.current = "delete";
		setMode("delete");
	};

	const submitRename = async (event) =>
	{
		event.preventDefault();
		const name = draft.trim();

		if (name === party.name)
		{
			setMode("view");
			return;
		}

		if (await onRename(party, name))
		{
			setMode("view");
		}
	};

	const confirmDelete = async () =>
	{
		if (!(await onDelete(party)))
		{
			setMode("view");
		}
	};

	if (mode === "edit")
	{
		return (
			<li>
				<form onSubmit={submitRename} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
					<input
						type="text"
						required
						autoFocus
						maxLength={MAX_NAME_LENGTH}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) =>
						{
							if (event.key === "Escape")
							{
								setMode("view");
							}
						}}
						aria-label={`Nazwa zleceniodawcy ${party.name}`}
						className="field min-w-0 flex-1" />
					<div className="flex shrink-0 gap-2">
						<button type="submit" disabled={isBusy || !draft.trim()} className="btn btn-primary">
							<Check className="h-4 w-4" aria-hidden="true" />
							{isBusy ? "Zapisywanie..." : "Zapisz"}
						</button>
						<button type="button" onClick={() => setMode("view")} disabled={isBusy} className="btn btn-secondary">
							Anuluj
						</button>
					</div>
				</form>
				<RowError message={errorMessage} />
			</li>
		);
	}

	if (mode === "delete")
	{
		return (
			<li
				onKeyDown={(event) =>
				{
					if (event.key === "Escape" && !isBusy)
					{
						setMode("view");
					}
				}}>
				<div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
					<p className="min-w-0 wrap-break-word text-sm text-foreground">
						Usunąć zleceniodawcę <span className="font-semibold">{party.name}</span>?
					</p>
					<div className="flex shrink-0 gap-2">
						<button type="button" ref={confirmButtonRef} onClick={confirmDelete} disabled={isBusy} className="btn btn-danger">
							<Trash2 className="h-4 w-4" aria-hidden="true" />
							{isBusy ? "Usuwanie..." : "Usuń"}
						</button>
						<button type="button" onClick={() => setMode("view")} disabled={isBusy} className="btn btn-secondary">
							Anuluj
						</button>
					</div>
				</div>
				<RowError message={errorMessage} />
			</li>
		);
	}

	return (
		<li data-party-id={party.id}>
			<div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
				<span className="min-w-0 wrap-break-word text-foreground">{party.name}</span>
				<div className="flex shrink-0 gap-2">
					<button type="button" ref={editButtonRef} onClick={startEditing} className="btn btn-secondary">
						<Pencil className="h-4 w-4" aria-hidden="true" />
						Edytuj
					</button>
					<button type="button" ref={deleteButtonRef} onClick={startDeleting} className={`btn btn-secondary ${DANGER_HOVER}`}>
						<Trash2 className="h-4 w-4" aria-hidden="true" />
						Usuń
					</button>
				</div>
			</div>
			<RowError message={errorMessage} />
		</li>
	);
});

/**
 * Admin panel listing and managing one account's ordering parties (zleceniodawcy).
 * Mount it when the panel is opened; it loads the list on mount.
 * Errors from the panel's own actions are shown inside it, not through the list-level alert:
 * next to the affected row, or in a panel-level alert when no row is involved.
 * `clearSignal` is any value that changes whenever the parent clears its messages; the panel then drops its action error.
 * @param {{ userId: string, onClearMessages: () => void, clearSignal?: number, onClose?: () => void }} props
 */
export default function OrderingPartiesPanel({ userId, onClearMessages, clearSignal = 0, onClose })
{
	// null until the first response.
	const [parties, setParties] = useState(null);
	// Failed add, rename or delete: { message, partyId } with partyId null when no row is involved.
	const [error, setError] = useState(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadErrorMessage, setLoadErrorMessage] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const [newName, setNewName] = useState("");
	const [isAdding, setIsAdding] = useState(false);
	const [busyId, setBusyId] = useState(null);
	const headingRef = useRef(null);
	const listRef = useRef(null);
	const partiesRef = useRef(null);
	// Position of the row just deleted, so focus can move to its neighbour once the list updates.
	const focusAfterDeleteRef = useRef(null);

	partiesRef.current = parties;

	useEffect(() =>
	{
		setError(null);
	}, [clearSignal]);

	useEffect(() =>
	{
		const pending = focusAfterDeleteRef.current;

		if (!pending || busyId !== null || !parties)
		{
			return;
		}

		focusAfterDeleteRef.current = null;

		// The user already moved focus somewhere real while the request ran: leave it.
		if (document.activeElement && document.activeElement !== document.body)
		{
			return;
		}

		const neighbour = parties[Math.min(pending.index, parties.length - 1)];
		const button = neighbour
			? listRef.current?.querySelector(`[data-party-id="${CSS.escape(neighbour.id)}"] button`)
			: null;

		(button ?? headingRef.current)?.focus();
	}, [parties, busyId]);

	useEffect(() =>
	{
		const controller = new AbortController();

		const loadParties = async () =>
		{
			try
			{
				const response = await http.get(`${API_URL}?userId=${encodeURIComponent(userId)}`, {
					withCredentials: true,
					signal: controller.signal,
				});

				if (!controller.signal.aborted)
				{
					setParties(sortByName(response.data.orderingParties || []));
					setLoadFailed(false);
				}
			}
			catch (err)
			{
				if (!controller.signal.aborted)
				{
					setParties([]);
					setLoadFailed(true);
					setLoadErrorMessage(err.response?.data?.error || "Nie udało się pobrać zleceniodawców.");
				}
			}
		};

		void loadParties();

		return () =>
		{
			controller.abort();
		};
	}, [userId, reloadKey]);

	// Adding is blocked until the list is known, otherwise a new party would look like the whole list.
	const isFormLocked = loadFailed || parties === null;

	const retryLoad = () =>
	{
		setParties(null);
		setLoadFailed(false);
		setReloadKey((key) => key + 1);
		headingRef.current?.focus();
	};

	const addParty = async (event) =>
	{
		event.preventDefault();
		const name = newName.trim();

		if (!name || isFormLocked)
		{
			return;
		}

		setIsAdding(true);
		onClearMessages();
		setError(null);

		try
		{
			const response = await http.post(API_URL, { userId, name }, { withCredentials: true });
			setParties((current) => sortByName([...(current || []), response.data.orderingParty]));
			setNewName("");
		}
		catch (err)
		{
			setError({ message: err.response?.data?.error || "Nie udało się dodać zleceniodawcy.", partyId: null });
		}
		finally
		{
			setIsAdding(false);
		}
	};

	// Both handlers resolve to true on success so the row can leave its edit or confirm mode.
	const renameParty = useCallback(async (party, name) =>
	{
		setBusyId(party.id);
		onClearMessages();
		setError(null);

		try
		{
			const response = await http.put(API_URL, { id: party.id, name }, { withCredentials: true });
			setParties((current) =>
				sortByName(current.map((item) => (item.id === party.id ? response.data.orderingParty : item))),
			);
			return true;
		}
		catch (err)
		{
			setError({ message: err.response?.data?.error || "Nie udało się zapisać zleceniodawcy.", partyId: party.id });
			return false;
		}
		finally
		{
			setBusyId(null);
		}
	}, [onClearMessages]);

	const deleteParty = useCallback(async (party) =>
	{
		setBusyId(party.id);
		onClearMessages();
		setError(null);

		try
		{
			await http.delete(`${API_URL}?id=${encodeURIComponent(party.id)}`, { withCredentials: true });
			focusAfterDeleteRef.current = {
				index: partiesRef.current?.findIndex((item) => item.id === party.id) ?? 0,
			};
			setParties((current) => current.filter((item) => item.id !== party.id));
			return true;
		}
		catch (err)
		{
			setError({ message: err.response?.data?.error || "Nie udało się usunąć zleceniodawcy.", partyId: party.id });
			return false;
		}
		finally
		{
			setBusyId(null);
		}
	}, [onClearMessages]);

	return (
		<section aria-label="Zleceniodawcy" className="space-y-4 border-t border-line bg-background p-5">
			<div className="flex items-center justify-between">
				<h3 ref={headingRef} tabIndex={-1} className="font-semibold text-foreground outline-none">Zleceniodawcy</h3>
				{onClose && (
					<button type="button" onClick={onClose} className="btn btn-ghost -my-1.5 -mr-1.5 size-10 min-h-0 px-0" aria-label="Zamknij zleceniodawców">
						<X className="h-5 w-5" aria-hidden="true" />
					</button>
				)}
			</div>

			{parties === null ? (
				<p role="status" className="text-sm text-muted">Wczytywanie zleceniodawców...</p>
			) : parties.length === 0 ? (
				!loadFailed && <p className="text-sm text-muted">Brak zleceniodawców. Dodaj pierwszego poniżej.</p>
			) : (
				<ul ref={listRef} className="divide-y divide-line">
					{parties.map((party) =>
						<OrderingPartyRow
							key={party.id}
							party={party}
							errorMessage={error?.partyId === party.id ? error.message : ""}
							isBusy={busyId === party.id}
							onDelete={deleteParty}
							onRename={renameParty} />,
					)}
				</ul>
			)}

			{loadFailed && (
				<Alert
					tone="danger"
					action={(
						<button type="button" onClick={retryLoad} className="btn btn-secondary">
							<RotateCw className="h-4 w-4" aria-hidden="true" />
							Spróbuj ponownie
						</button>
					)}>
					{loadErrorMessage}
				</Alert>
			)}

			{error && !error.partyId && <Alert tone="danger">{error.message}</Alert>}

			<form onSubmit={addParty} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
				<label className="block min-w-0 flex-1 text-sm font-medium text-foreground">
					Nowy zleceniodawca
					<input
						type="text"
						maxLength={MAX_NAME_LENGTH}
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
						disabled={isFormLocked}
						placeholder="Nazwa zleceniodawcy"
						className="field mt-2" />
				</label>
				<button type="submit" disabled={isFormLocked || isAdding || !newName.trim()} className="btn btn-primary shrink-0">
					<Plus className="h-4 w-4" aria-hidden="true" />
					{isAdding ? "Dodawanie..." : "Dodaj"}
				</button>
			</form>
		</section>
	);
}
