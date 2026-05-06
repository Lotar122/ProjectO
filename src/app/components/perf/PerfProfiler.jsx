"use client";

import { Profiler } from "react";
import { getPerfFlags } from "./perfFlags";

const reportCommit = (
	id,
	phase,
	actualDuration,
	baseDuration,
	startTime,
	commitTime,
) =>
{
	if (typeof window === "undefined")
	{
		return;
	}

	window.__PROJECTO_PERF_REPORT_COMMIT__?.({
		id,
		phase,
		actualDuration,
		baseDuration,
		startTime,
		commitTime,
	});
};

export default function PerfProfiler({ children, id })
{
	if (!getPerfFlags().debug)
	{
		return children;
	}

	return (
		<Profiler
			id={id}
			onRender={(
				profilerId,
				phase,
				actualDuration,
				baseDuration,
				startTime,
				commitTime,
			) =>
			{
				reportCommit(
					profilerId,
					phase,
					actualDuration,
					baseDuration,
					startTime,
					commitTime,
				);
			}}>
			{children}
		</Profiler>
	);
}
