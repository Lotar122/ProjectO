const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const hasEnabledValue = (value) =>
	value != null && TRUE_VALUES.has(String(value).toLowerCase());

export const DEFAULT_PERF_FLAGS = {
	debug: false,
	disableMotion: false,
	disableScrollListeners: false,
	disableVisualEffects: false,
};

export function getPerfFlags()
{
	if (typeof window === "undefined")
	{
		return DEFAULT_PERF_FLAGS;
	}

	const searchParams = new URLSearchParams(window.location.search);

	return {
		debug: hasEnabledValue(searchParams.get("perfDebug")),
		disableMotion: hasEnabledValue(searchParams.get("perfDisableMotion")),
		disableScrollListeners: hasEnabledValue(
			searchParams.get("perfDisableScrollListeners"),
		),
		disableVisualEffects: hasEnabledValue(
			searchParams.get("perfDisableVisualEffects"),
		),
	};
}
