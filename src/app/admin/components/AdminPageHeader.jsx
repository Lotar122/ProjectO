/**
 * Title row shared by every admin page: the h1 matches the top bar label.
 * @param {{ title: string, description: string, action?: import("react").ReactNode }} props
 */
export default function AdminPageHeader({ title, description, action })
{
	return (
		<div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
			<div className="min-w-0">
				<h1 className="text-2xl font-bold text-balance text-foreground sm:text-3xl">{title}</h1>
				<p className="mt-2 max-w-[65ch] text-pretty text-muted">{description}</p>
			</div>
			{action}
		</div>
	);
}
