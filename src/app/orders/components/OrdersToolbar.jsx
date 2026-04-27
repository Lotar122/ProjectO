"use client";

import { Search } from "lucide-react";

import { ORDER_STATUS_OPTIONS } from "../orderUtils";

export default function OrdersToolbar({
	orderFilterRef,
	orderSearchRef,
	onSearchChange,
	onStatusChange,
})
{
	return (
		<div className="mb-8 rounded-xl border border-slate-800 bg-slate-900/85 p-6 backdrop-blur">
			<div className="flex flex-col gap-4 md:flex-row">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
					<input
						ref={orderSearchRef}
						onChange={(event) => onSearchChange(event.target.value)}
						type="text"
						placeholder="Search orders..."
						className="w-full rounded-lg border border-slate-700 bg-slate-950 py-3 pl-10 pr-4 text-slate-100 transition-all duration-300 placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
					/>
				</div>
				<div className="flex gap-2">
					<select
						ref={orderFilterRef}
						defaultValue="All Status"
						onChange={(event) => onStatusChange(event.target.value)}
						className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none">
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
