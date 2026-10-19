// Route-level loading UI: shown immediately while server components wait on
// Kratos/Postgres, instead of a blank page.
export default function Loading()
{
	return (
		<div className="flex min-h-dvh items-center justify-center bg-transparent">
			<div className="text-center">
				<div className="mx-auto mb-5 h-24 w-24 animate-spin rounded-full border-4 border-white/25 border-t-white" />
				<h1 className="animate-fade-in-up mb-2 text-3xl font-bold text-white">ProjectO</h1>
				<p className="animate-fade-in-up text-gray-400 [animation-delay:80ms]">
					System zarządzania ortodontycznego
				</p>
			</div>
		</div>
	);
}
