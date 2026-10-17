// Small fetch wrapper with the slice of the axios API this app used, so axios
// (and its Node adapter's follow-redirects / url.parse() dependency) could be
// dropped. Same contract as before:
//   - resolves to { data, status, statusText, headers } (header names lowercased)
//   - rejects on non-2xx with err.response = { status, statusText, data, headers }
//   - network failures reject without err.response
//   - responseType: "blob" returns a Blob for success and error bodies alike

export class HttpError extends Error
{
	constructor(response)
	{
		super(`Request failed with status code ${response.status}`);
		this.name = "HttpError";
		this.response = response;
	}
}

const parseBody = async (response, responseType) =>
{
	if (responseType === "blob")
	{
		return response.blob();
	}

	const text = await response.text();

	if (!text)
	{
		return null;
	}

	try
	{
		return JSON.parse(text);
	}
	catch
	{
		return text;
	}
};

async function request(method, url, body, config = {})
{
	// Kratos browser flows answer with JSON only when asked; otherwise they
	// redirect to the UI. axios sent this Accept header by default.
	const headers = {
		Accept: "application/json",
		...config.headers,
	};
	let payload = body;

	if (body instanceof FormData)
	{
		// The browser must set multipart/form-data itself, with the boundary.
		for (const name of Object.keys(headers))
		{
			if (name.toLowerCase() === "content-type")
			{
				delete headers[name];
			}
		}
	}
	else if (body !== undefined)
	{
		payload = JSON.stringify(body);
		headers["Content-Type"] ??= "application/json";
	}

	const response = await fetch(url, {
		method,
		headers,
		body: payload,
		credentials: config.withCredentials ? "include" : "same-origin",
	});

	const result = {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
		data: await parseBody(response, config.responseType),
	};

	if (!response.ok)
	{
		throw new HttpError(result);
	}

	return result;
}

const http = {
	get: (url, config) => request("GET", url, undefined, config),
	delete: (url, config) => request("DELETE", url, undefined, config),
	post: (url, data, config) => request("POST", url, data, config),
	put: (url, data, config) => request("PUT", url, data, config),
};

export default http;
