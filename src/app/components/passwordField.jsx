"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

export default function PasswordField({
	autoComplete = "current-password",
	hint,
	id,
	invalid = false,
	label = "Hasło",
	name,
	password,
	placeholder = "Wpisz hasło",
	required = true,
	setPassword,
})
{
	const [showPassword, setShowPassword] = useState(false);
	const hintId = `${useId()}-hint`;

	return (
		<div>
			<label htmlFor={id} className="field-label">
				{label}
			</label>
			<div className="relative">
				<input
					id={id}
					name={name}
					autoComplete={autoComplete}
					type={showPassword ? "text" : "password"}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="field pr-12"
					placeholder={placeholder}
					required={required}
					aria-invalid={invalid || undefined}
					aria-describedby={hint ? hintId : undefined}
				/>
				<button
					type="button"
					onClick={() => setShowPassword(!showPassword)}
					aria-label={showPassword ? "Ukryj hasło" : "Pokaż hasło"}
					className="btn btn-ghost absolute right-1 top-1/2 size-10 min-h-0 -translate-y-1/2 px-0">
					{showPassword ? (
						<EyeOff className="h-5 w-5" aria-hidden="true" />
					) : (
						<Eye className="h-5 w-5" aria-hidden="true" />
					)}
				</button>
			</div>
			{hint && (
				<p id={hintId} className="field-hint">
					{hint}
				</p>
			)}
		</div>
	);
}
