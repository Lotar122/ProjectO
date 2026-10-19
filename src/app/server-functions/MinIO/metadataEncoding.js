// S3 user metadata is sent as HTTP headers, which only allow ASCII.
// Encode on write, decode on read.

export function encodeMetadataValue(value)
{
	return encodeURIComponent(String(value ?? ""));
}

// Tolerates legacy objects whose raw (unencoded) value was stored.
export function decodeMetadataValue(value)
{
	if (typeof value !== "string")
	{
		return value;
	}

	try
	{
		return decodeURIComponent(value);
	}
	catch
	{
		return value;
	}
}
