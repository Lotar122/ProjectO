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

export const createLocalAttachments = (files) =>
	files.map((file, index) => ({
		id: `local-${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
		name: file.name,
		file,
		isLocal: true,
	}));

export const ORDER_STATUS_OPTIONS = [
	"All Status",
	"Pending",
	"In Progress",
	"Shipped",
	"Completed",
];

export const getFilteredOrders = (orders, searchValue, statusValue) => {
	const normalizedSearch = searchValue.trim().toLowerCase();
	const normalizedStatus = statusValue.toLowerCase().replace(" ", "-");

	return orders.filter((order) => {
		const matchesSearch =
			normalizedSearch === "" ||
			order.patient.toLowerCase().includes(normalizedSearch);
		const matchesStatus =
			statusValue === "All Status" ||
			order.status.toLowerCase() === normalizedStatus;

		return matchesSearch && matchesStatus;
	});
};

export const getDisplayDate = (order) =>
	order.due_date?.slice(0, 10) || order.dueDate?.slice(0, 10) || "";

export const getOrderFiles = (order, fileNamesById) => {
	if (Array.isArray(order.frontendFiles)) {
		return order.frontendFiles;
	}

	if (Array.isArray(order.uploadedFiles) && order.uploadedFiles.length > 0) {
		return order.uploadedFiles.map((file, index) => ({
			id: file.id || `${order.order_id || order.patient}-${index}`,
			name: file.name || `Attachment ${index + 1}`,
			file,
			isLocal: true,
		}));
	}

	if (!Array.isArray(order.files)) {
		return [];
	}

	return order.files.map((fileId, index) => ({
		id: String(fileId),
		name: fileNamesById[fileId] || `Attachment ${index + 1}`,
		fileId,
		isLocal: false,
	}));
};

export const getStatusTheme = (status) => {
	switch (status) {
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
