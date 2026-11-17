"use client";

import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ORDER_STATUS_OPTIONS } from "../orderUtils";

const SEARCH_DEBOUNCE_MS = 250;

// The typed text lives here, so a keystroke re-renders only the toolbar; the
// page is told about the search once typing pauses.
export default function OrdersToolbar({
	initialSearchValue = "",
	onSearchChange,
	onStatusChange,
	statusValue,
	isAdmin = false,
})
{
	const [searchValue, setSearchValue] = useState(initialSearchValue);
	const committedSearchRef = useRef(initialSearchValue);
	const onSearchChangeRef = useRef(onSearchChange);

	useEffect(() =>
	{
		onSearchChangeRef.current = onSearchChange;
	}, [onSearchChange]);

	useEffect(() =>
	{
		if (searchValue === committedSearchRef.current)
		{
			return;
		}

		const timeoutId = window.setTimeout(() =>
		{
			committedSearchRef.current = searchValue;
			onSearchChangeRef.current(searchValue);
		}, SEARCH_DEBOUNCE_MS);

		return () =>
		{
			window.clearTimeout(timeoutId);
		};
	}, [searchValue]);

	return (
		<div className="mb-6 rounded-xl border border-line bg-surface p-4 sm:mb-8 sm:p-6">
			<div className="flex flex-col gap-4 md:flex-row">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" aria-hidden="true" />
					<input
						value={searchValue}
						onChange={(event) => setSearchValue(event.target.value)}
						type="text"
						aria-label={isAdmin ? "Szukaj zleceń lub lekarza" : "Szukaj zleceń"}
						placeholder={isAdmin ? "Szukaj zleceń lub lekarza..." : "Szukaj zleceń..."}
						className="field pl-10"
					/>
				</div>
				<div className="flex gap-2">
					<select
						value={statusValue}
						onChange={(event) => onStatusChange(event.target.value)}
						aria-label="Filtruj według statusu"
						className="field md:w-auto">
						{ORDER_STATUS_OPTIONS.map((status) => (
							<option
								key={status}
								value={status}
								className="bg-surface-sunken text-foreground">
								{status}
							</option>
						))}
					</select>
				</div>
			</div>
		</div>
	);
}
