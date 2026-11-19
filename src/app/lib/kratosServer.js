import "server-only";

// Docker-network defaults are for local development only. In production the
// URLs must come from the environment, so a missing variable surfaces at
// startup (see instrumentation-node.js) instead of silently talking to the
// wrong host.
function devDefault(value)
{
	return process.env.NODE_ENV !== "production" ? value : undefined;
}

// Callers append "/path", so a trailing slash in the env value would produce "//".
function stripTrailingSlashes(value)
{
	return value?.replace(/\/+$/, "");
}

export const KRATOS_PUBLIC_INTERNAL_URL = stripTrailingSlashes(
	process.env.KRATOS_PUBLIC_INTERNAL_URL || devDefault("http://kratos:4433"),
);

export const KRATOS_ADMIN_URL = stripTrailingSlashes(
	process.env.KRATOS_ADMIN_URL || devDefault("http://kratos:4434"),
);
