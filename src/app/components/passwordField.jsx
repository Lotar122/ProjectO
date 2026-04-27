"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export default function PasswordField({ password, setPassword })
{
	const [showPassword, setShowPassword] = useState(false);

	return (
		<div>
			<label className="mb-2 block text-sm font-medium text-slate-300">
				Password
			</label>
			<div className="relative">
				<input
					type={showPassword ? "text" : "password"}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 pr-12 text-white transition-all duration-300 focus:border-sky-300/60 focus:ring-2 focus:ring-sky-200/20 focus:outline-none"
					placeholder="Enter your password"
					required
				/>
				<button
					type="button"
					onClick={() => setShowPassword(!showPassword)}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-200">
					{showPassword ? (
						<EyeOff className="w-5 h-5" />
					) : (
						<Eye className="w-5 h-5" />
					)}
				</button>
			</div>
		</div>
	);
}
