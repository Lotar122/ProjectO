import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

const TONES = {
	danger: { classes: "border-danger-line bg-danger-soft text-danger-text", icon: CircleAlert, role: "alert" },
	success: { classes: "border-success-line bg-success-soft text-success-text", icon: CircleCheck, role: "status" },
	info: { classes: "border-accent-line bg-accent-soft text-accent-text", icon: Info, role: "status" },
};

/**
 * Inline message. The icon and text carry the meaning, color only reinforces it.
 * @param {{ tone: "danger" | "success" | "info", icon?: import("react").ElementType, announce?: boolean, action?: import("react").ReactNode, onDismiss?: () => void, className?: string, children: import("react").ReactNode }} props
 * `announce={false}` drops the live role for messages that already sit inside an aria-live region.
 * `action` is an optional control (for example a retry button) shown next to the text.
 * `onDismiss` adds a close button (label "Zamknij") that calls it.
 */
export default function Alert({ tone, icon, announce = true, action, onDismiss, className = "", children })
{
	const { classes, icon: ToneIcon, role } = TONES[tone];
	const Icon = icon ?? ToneIcon;
	const message = <p className="min-w-0 wrap-break-word">{children}</p>;

	return (
		<div
			role={announce ? role : undefined}
			className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${classes} ${className}`}>
			<Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			{action
				? (
					<div className="min-w-0 flex-1">
						{message}
						<div className="mt-3">{action}</div>
					</div>
				)
				: message}
			{onDismiss && (
				<button
					type="button"
					onClick={onDismiss}
					aria-label="Zamknij"
					className="focus-ring -my-2 -mr-2.5 ml-auto flex size-9 shrink-0 items-center justify-center rounded-lg opacity-70 transition-opacity hover:opacity-100">
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}
