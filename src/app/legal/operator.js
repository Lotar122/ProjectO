// Operator details used in the legal texts, read from the environment (see README).
// An unset variable leaves a visible bracket placeholder so a missing value is noticed.
const fromEnv = (name, placeholder) => process.env[name]?.trim() || placeholder;

export const OPERATOR = {
	name: fromEnv("LEGAL_OPERATOR_NAME", "[PEŁNA NAZWA FIRMY LUB IMIĘ I NAZWISKO]"),
	address: fromEnv("LEGAL_OPERATOR_ADDRESS", "[ADRES SIEDZIBY]"),
	taxId: fromEnv("LEGAL_OPERATOR_TAX_ID", "[NIP]"),
	email: fromEnv("LEGAL_OPERATOR_EMAIL", "[ADRES E-MAIL DO KONTAKTU I WNIOSKÓW O USUNIĘCIE DANYCH]"),
	updated: "25 listopada 2026",
};
