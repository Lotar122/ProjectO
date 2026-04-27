import { defineConfig, globalIgnores } from "eslint/config";
import stylistic from "@stylistic/eslint-plugin";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
	...nextVitals,
	{
		files: ["**/*.{js,jsx,mjs}"],
		plugins: {
			"@stylistic": stylistic,
		},
		rules: {
			"@stylistic/brace-style": ["error", "allman", { allowSingleLine: false }],
			"@stylistic/indent": ["error", "tab", { SwitchCase: 1 }],
			"no-tabs": "off",
		},
	},
	// Override default ignores of eslint-config-next.
	globalIgnores([
		// Default ignores of eslint-config-next:
		".next/**",
		"out/**",
		"build/**",
		"next-env.d.ts",
	]),
]);

export default eslintConfig;
