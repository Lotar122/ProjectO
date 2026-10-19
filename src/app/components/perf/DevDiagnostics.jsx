"use client";

import { Suspense, lazy } from "react";

// Scroll diagnostics patch DOM prototypes, so they exist in development only.
// The NODE_ENV check is a compile-time constant: production builds drop the
// import() and the module never reaches the bundle.
const ScrollPerfDiagnostics =
	process.env.NODE_ENV === "production" ?
		null :
		lazy(() => import("./ScrollPerfDiagnostics"));

export default function DevDiagnostics()
{
	if (!ScrollPerfDiagnostics)
	{
		return null;
	}

	return (
		<Suspense fallback={null}>
			<ScrollPerfDiagnostics />
		</Suspense>
	);
}
