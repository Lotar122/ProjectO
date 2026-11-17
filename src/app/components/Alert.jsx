import { CircleAlert, CircleCheck, Info } from "lucide-react";

const TONES = {
	danger: { classes: "border-danger-line bg-danger-soft text-danger-text", icon: CircleAlert, role: "alert" },
	success: { classes: "border-success-line bg-success-soft text-success-text", icon: CircleCheck, role: "status" },
	info: { classes: "border-accent-line bg-accent-soft text-accent-text", icon: Info, role: "status" },
};

/**
 * Inline message. The icon and text carry the meaning, color only reinforces it.
 * @param {{ tone: "danger" | "success" | "info", icon?: import("react").ElementType, announce?: boolean, className?: string, children: import("react").ReactNode }} props
 * `announce={false}` drops the live role for messages that already sit inside an aria-live region.
 */
export default function Alert({ tone, icon, announce = true, className = "", children })
{
	const { classes, icon: ToneIcon, role } = TONES[tone];
	const Icon = icon ?? ToneIcon;

	return (
		<div
			role={announce ? role : undefined}
			className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${classes} ${className}`}>
			<Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<p className="min-w-0 wrap-break-word">{children}</p>
		</div>
	);
}
