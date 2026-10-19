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
		<div className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:mb-8 sm:p-6">
			<div className="flex flex-col gap-4 md:flex-row">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
					<input
						value={searchValue}
						onChange={(event) => setSearchValue(event.target.value)}
						type="text"
						placeholder={isAdmin ? "Szukaj zleceń lub lekarza..." : "Szukaj zleceń..."}
						className="w-full rounded-lg border border-slate-700 bg-slate-950 py-3 pl-10 pr-4 text-slate-100 transition-colors duration-200 placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
					/>
				</div>
				<div className="flex gap-2">
					<select
						value={statusValue}
						onChange={(event) => onStatusChange(event.target.value)}
						className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-colors duration-200 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none md:w-auto">
						{ORDER_STATUS_OPTIONS.map((status) => (
							<option
								key={status}
								value={status}
								className="bg-slate-950 text-slate-100">
								{status}
							</option>
						))}
					</select>
				</div>
			</div>
		</div>
	);
}
