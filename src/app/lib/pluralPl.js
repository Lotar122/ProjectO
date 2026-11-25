/**
 * Picks the Polish plural form for a count.
 * @param {number} n integer count
 * @param {readonly [string, string, string]} forms [one, few, many], e.g. ["plik", "pliki", "plików"]
 * @returns {string}
 */
export function pluralPl(n, forms)
{
	if (!Number.isInteger(n))
	{
		throw new TypeError("pluralPl: n must be an integer.");
	}
	if (!Array.isArray(forms) || forms.length !== 3)
	{
		throw new TypeError("pluralPl: forms must be [one, few, many].");
	}

	const count = Math.abs(n);
	if (count === 1)
	{
		return forms[0];
	}

	const lastDigit = count % 10;
	const lastTwoDigits = count % 100;
	const isFew = lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14);

	return isFew ? forms[1] : forms[2];
}
