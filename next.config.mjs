const isProduction = process.env.NODE_ENV === "production";

const kratosOrigin = (() =>
{
	try
	{
		return new URL(
			process.env.NEXT_PUBLIC_KRATOS_PUBLIC_URL || "https://orto.lotar122.dev/kratos",
		).origin;
	}
	catch
	{
		return "";
	}
})();

// Next.js hydrates through inline scripts, so script-src needs 'unsafe-inline'
// (a nonce would force every page to render dynamically). The rest stays tight.
const contentSecurityPolicy = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	`connect-src 'self' ${kratosOrigin}${isProduction ? "" : " ws: wss:"}`,
	"object-src 'none'",
	"base-uri 'self'",
	`form-action 'self' ${kratosOrigin}`,
	"frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: contentSecurityPolicy },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
	...(isProduction ?
		[{ key: "Strict-Transport-Security", value: "max-age=31536000" }] :
		[]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
	/* config options here */
	allowedDevOrigins: ["orto.lotar122.dev"],
	poweredByHeader: false,
	async headers()
	{
		return [{ source: "/:path*", headers: securityHeaders }];
	},
};

export default nextConfig;
