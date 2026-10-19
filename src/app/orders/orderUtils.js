export const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";
export const UPLOAD_LIMIT = "UPLOAD_LIMIT";

// Same limits the API enforces (see multipartUpload.js); checked up front so a
// too-large order is refused before anything is hashed or sent.
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_LIMIT_MESSAGE =
	"Pliki przekraczają limit: do 20 plików, do 250 MB każdy i do 1 GB łącznie na zlecenie.";

export const getUploadLimitError = (files) =>
{
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

	return (
		files.length > MAX_UPLOAD_FILES ||
		totalBytes > MAX_UPLOAD_TOTAL_BYTES ||
		files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)
	) ? UPLOAD_LIMIT_MESSAGE : null;
};

// Returns null when crypto.subtle is unavailable (non-secure context); the server then skips the comparison
export const computeSha256Hex = async (blob) =>
{
	if (!globalThis.crypto?.subtle)
	{
		return null;
	}

	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		await blob.arrayBuffer(),
	);

	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

// One file at a time: crypto.subtle needs the whole file in memory, so hashing
// them in parallel held every selected scan in RAM at once.
export const computeSha256HexSequentially = async (blobs) =>
{
	const checksums = [];

	for (const blob of blobs)
	{
		checksums.push(blob ? await computeSha256Hex(blob) : null);
	}

	return checksums;
};

// The API streams uploads, so every text field and the checksums (one per
// file, same order) must be appended before the first file.
export const appendUploadFiles = (formData, files, checksums) =>
{
	checksums.forEach((checksum) =>
	{
		formData.append("fileChecksums", checksum ?? "");
	});
	files.forEach(({ file, name }) =>
	{
		formData.append("files", file, name);
	});
};

// Stable React keys for files that have no id of their own.
const localFileKeys = new WeakMap();
let nextLocalFileKey = 0;

export const getLocalFileKey = (file) =>
{
	if (!localFileKeys.has(file))
	{
		localFileKeys.set(file, `file-${nextLocalFileKey++}`);
	}

	return localFileKeys.get(file);
};

// Works for both JSON and blob (download) error responses
export const getErrorResponseData = async (err) =>
{
	const data = err?.response?.data;

	if (!(data instanceof Blob))
	{
		return data;
	}

	try
	{
		return JSON.parse(await data.text());
	}
	catch
	{
		return null;
	}
};

export const getUploadLimitResponseError = async (err) =>
{
	const data = await getErrorResponseData(err);

	return data?.code === UPLOAD_LIMIT ? data : null;
};

export const getChecksumMismatchError = async (err) =>
{
	const data = await getErrorResponseData(err);

	return data?.code === CHECKSUM_MISMATCH ? data : null;
};

export const INITIAL_ORDER = {
	patient: "",
	details: "",
	dueDate: new Date().toISOString().split("T")[0],
};

export const INITIAL_EDIT_DRAFT = {
	patient: "",
	details: "",
	dueDate: "",
};

export const sanitizeDownloadPart = (value) =>
	String(value ?? "")
		.trim()
		.replace(/[\\/:*?"<>|]+/g, " ")
		.replace(/\s+/g, " ");

export const buildOrderFileName = (patient, fileName) =>
{
	const safePatient = sanitizeDownloadPart(patient);
	const safeFileName = sanitizeDownloadPart(fileName);

	if (!safePatient)
	{
		return safeFileName || "pobierz";
	}

	if (!safeFileName)
	{
		return safePatient;
	}

	return `${safePatient} ${safeFileName}`;
};

export const createLocalAttachments = (files, patient) =>
	files.map((file, index) => ({
		id: `local-${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
		name: buildOrderFileName(patient, file.name),
		file,
		isLocal: true,
	}));

export const STATUS_LABELS = {
	pending: "OCZEKUJĄCE",
	"in-progress": "W REALIZACJI",
	shipped: "GOTOWE",
	completed: "ZREALIZOWANE",
};

export const ORDER_STATUS_OPTIONS = [
	"Wszystkie statusy",
	"Oczekujące",
	"W realizacji",
	"Gotowe",
	"Zrealizowane",
];

export const ORDER_STATUS_VALUES = [
	"pending",
	"in-progress",
	"shipped",
	"completed",
];

const POLISH_STATUS_VALUES = {
	"oczekujące": "pending",
	"w realizacji": "in-progress",
	"gotowe": "shipped",
	"zrealizowane": "completed",
};

export const normalizeOrderStatus = (value) =>
{
	const normalizedValue = String(value ?? "").trim().toLowerCase();

	return POLISH_STATUS_VALUES[normalizedValue] || normalizedValue.replace(/\s+/g, "-");
};

export const getDisplayDate = (order) =>
	order.due_date?.slice(0, 10) || order.dueDate?.slice(0, 10) || "";

export const getOrderFiles = (order, fileNamesById) =>
{
	if (Array.isArray(order.frontendFiles))
	{
		return order.frontendFiles;
	}

	if (Array.isArray(order.uploadedFiles) && order.uploadedFiles.length > 0)
	{
		return order.uploadedFiles.map((file, index) => ({
			id: file.id || `${order.order_id || order.patient}-${index}`,
			name: buildOrderFileName(
				order.patient,
				file.name || `Attachment ${index + 1}`,
			),
			file,
			isLocal: true,
		}));
	}

	if (!Array.isArray(order.files))
	{
		return [];
	}

	return order.files.map((fileId, index) => ({
		id: String(fileId),
		name: buildOrderFileName(
			order.patient,
			fileNamesById[fileId] || `Attachment ${index + 1}`,
		),
		fileId,
		isLocal: false,
	}));
};

export const getStatusTheme = (status) =>
{
	switch (status)
	{
		case "completed":
			return {
				badgeClass: "bg-green-100 text-green-800",
				progressClass: "bg-green-500",
			};
		case "in-progress":
			return {
				badgeClass: "bg-blue-100 text-blue-800",
				progressClass: "bg-blue-500",
			};
		case "pending":
			return {
				badgeClass: "bg-yellow-100 text-yellow-800",
				progressClass: "bg-yellow-500",
			};
		case "shipped":
			return {
				badgeClass: "bg-purple-100 text-purple-800",
				progressClass: "bg-purple-500",
			};
		default:
			return {
				badgeClass: "bg-gray-100 text-gray-800",
				progressClass: "bg-gray-500",
			};
	}
};
