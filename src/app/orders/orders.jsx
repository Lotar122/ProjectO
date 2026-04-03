"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	CheckCircle,
	ChevronDown,
	Clock,
	Download,
	FileText,
	LogOut,
	Package,
	Plus,
	Search,
	Trash2,
	UserCircle,
	XCircle,
} from "lucide-react";
import axios from "axios";

const INITIAL_ORDER = {
	patient: "",
	details: "",
	dueDate: new Date().toISOString().split("T")[0],
};

const getFilteredOrders = (orders, searchValue, statusValue) => {
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

const getDisplayDate = (order) =>
	order.due_date?.slice(0, 10) || order.dueDate?.slice(0, 10) || "";

const getOrderFiles = (order) => {
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
		name: `Attachment ${index + 1}`,
		fileId,
		isLocal: false,
	}));
};

export default function Orders({ userName, userLastName }) {
	const [currentPage, setCurrentPage] = useState("orders");
	const [allOrders, setAllOrders] = useState([]);
	const [orders, setOrders] = useState([]);
	const [newOrder, setNewOrder] = useState(INITIAL_ORDER);
	const [files, setFiles] = useState([]);
	const [hoveredOrder, setHoveredOrder] = useState(null);
	const [deleteOrderId, setDeleteOrderId] = useState(null);
	const [expandedOrderId, setExpandedOrderId] = useState(null);
	const orderFilterRef = useRef(null);
	const orderSearchRef = useRef(null);

	const syncVisibleOrders = useCallback((sourceOrders) => {
		const searchValue = orderSearchRef.current?.value || "";
		const statusValue = orderFilterRef.current?.value || "All Status";
		setOrders(getFilteredOrders(sourceOrders, searchValue, statusValue));
	}, []);

	const refreshOrders = useCallback(async () => {
		const response = await axios.get("/api/getOrders", {
			withCredentials: true,
		});
		const nextOrders = [...response.data].reverse();

		nextOrders.forEach((val, index) => {
			val.files.forEach((val, index) => {
				const response = axios.get("/api/getFileName",
					{
						params: {file_id: val.id}
					},
					{
						withCredentials: true,
					}
				).then(() => {val.name = response.filename});
			});
		});

		setAllOrders(nextOrders);
		syncVisibleOrders(nextOrders);
	}, [syncVisibleOrders]);

	useEffect(() => {
		void refreshOrders();
	}, [refreshOrders]);

	const handleLogout = async () => {
		try {
			const response = await axios.get(
				"https://orto.lotar122.dev/kratos/self-service/logout/browser",
				{
					withCredentials: true,
				},
			);

			window.location.href = response.data.logout_url;
		} catch (err) {
			console.error("Logout error:", err);
		}
	};

	const getStatusColor = (status) => {
		switch (status) {
			case "completed":
				return "bg-green-100 text-green-800";
			case "in-progress":
				return "bg-blue-100 text-blue-800";
			case "pending":
				return "bg-yellow-100 text-yellow-800";
			case "shipped":
				return "bg-purple-100 text-purple-800";
			default:
				return "bg-gray-100 text-gray-800";
		}
	};

	const getStatusIcon = (status) => {
		switch (status) {
			case "completed":
				return <CheckCircle className="w-4 h-4" />;
			case "in-progress":
			case "pending":
				return <Clock className="w-4 h-4" />;
			case "shipped":
				return <Package className="w-4 h-4" />;
			default:
				return <XCircle className="w-4 h-4" />;
		}
	};

	const handleCreateOrder = async (e) => {
		e.preventDefault();

		if (!newOrder.patient || !newOrder.details) {
			return;
		}

		const order = {
			patient: newOrder.patient,
			details: newOrder.details,
			status: "pending",
			dueDate: newOrder.dueDate,
			issueDate: new Date().toISOString(),
			progress: 0,
			uploadedFiles: files.map((file, index) => ({
				id: `${file.name}-${index}-${file.size}`,
				name: file.name,
				file,
			})),
		};

		try {
			const formData = new FormData();

			formData.append("patient", order.patient);
			formData.append("details", order.details);
			formData.append("status", order.status);
			formData.append("dueDate", order.dueDate);
			formData.append("issueDate", order.issueDate);
			formData.append("progress", String(order.progress));

			files.forEach((file) => {
				formData.append("files", file);
			});

			const response = await axios.post("/api/postOrder", formData, {
				withCredentials: true,
				headers: {
					"Content-Type": "multipart/form-data",
				},
			});

			const nextOrders = [
				{
					...order,
					order_id: response.data.orderID,
				},
				...allOrders,
			];

			setAllOrders(nextOrders);
			syncVisibleOrders(nextOrders);
			setNewOrder(INITIAL_ORDER);
			setFiles([]);
			setCurrentPage("orders");
			setExpandedOrderId(response.data.orderID);
		} catch (err) {
			console.error("Order creation failed:", err);
		}
	};

	const handleSearchChange = (searchValue) => {
		const statusValue = orderFilterRef.current?.value || "All Status";
		setOrders(getFilteredOrders(allOrders, searchValue, statusValue));
	};

	const handleStatusChange = (statusValue) => {
		const searchValue = orderSearchRef.current?.value || "";
		setOrders(getFilteredOrders(allOrders, searchValue, statusValue));
	};

	const showOrdersPage = () => {
		setCurrentPage("orders");
		syncVisibleOrders(allOrders);
	};

	const confirmDelete = async () => {
		if (!deleteOrderId) {
			return;
		}

		try {
			await axios.delete(`/api/deleteOrder?orderID=${deleteOrderId}`, {
				withCredentials: true,
			});
			await refreshOrders();
		} catch (err) {
			console.error(err);
		} finally {
			setDeleteOrderId(null);
		}
	};

	const toggleOrderExpanded = (orderId) => {
		setExpandedOrderId((current) => (current === orderId ? null : orderId));
	};

	const handleDownloadFile = (order, attachment) => {
		if (attachment.isLocal && attachment.file instanceof File) {
			const objectUrl = URL.createObjectURL(attachment.file);
			const link = document.createElement("a");
			link.href = objectUrl;
			link.download = attachment.name;
			link.click();
			URL.revokeObjectURL(objectUrl);
			return;
		}

		const placeholderContent = [
			"Frontend placeholder download",
			`Order: ${order.order_id}`,
			`Patient: ${order.patient}`,
			`Attachment: ${attachment.name}`,
			`File reference: ${attachment.fileId}`,
		].join("\n");
		const blob = new Blob([placeholderContent], { type: "text/plain" });
		const objectUrl = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = objectUrl;
		link.download = `${attachment.name}.txt`;
		link.click();
		URL.revokeObjectURL(objectUrl);
	};

	return (
		<div className="min-h-screen bg-black text-white">
			{deleteOrderId && (
				<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
					<div className="bg-gray-900 p-6 rounded-xl w-80">
						<h2 className="text-lg font-semibold text-white mb-4">
							Delete Order?
						</h2>
						<p className="text-gray-400 mb-6">
							Are you sure you want to delete this order? This action cannot be
							undone.
						</p>
						<div className="flex justify-end gap-4">
							<button
								onClick={() => setDeleteOrderId(null)}
								className="px-4 py-2 bg-gray-700 rounded hover:bg-gray-600 transition-colors">
								Cancel
							</button>
							<button
								onClick={confirmDelete}
								className="px-4 py-2 bg-red-600 rounded hover:bg-red-500 text-white transition-colors">
								Delete
							</button>
						</div>
					</div>
				</div>
			)}

			<header className="bg-gray-900 border-b border-gray-800">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center">
								<Package className="w-6 h-6 text-black" />
							</div>
							<h1 className="text-2xl font-bold text-white">ProjectO</h1>
						</div>

						<nav className="hidden md:flex items-center gap-6">
							<button
								onClick={showOrdersPage}
								className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
									currentPage === "orders"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Package className="w-4 h-4" />
								Orders
							</button>
							<button
								onClick={() => setCurrentPage("create-order")}
								className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
									currentPage === "create-order"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Plus className="w-4 h-4" />
								New Order
							</button>
						</nav>

						<div className="flex items-center gap-4">
							<div className="hidden md:flex items-center gap-2 text-sm text-gray-300">
								<UserCircle className="w-5 h-5" />
								Dr. {userLastName || userName}
							</div>
							<button
								onClick={handleLogout}
								className="flex items-center gap-2 px-4 py-2 text-gray-300 hover:text-white transition-colors">
								<LogOut className="w-4 h-4" />
								Logout
							</button>
						</div>
					</div>
				</div>
			</header>

			<div className="md:hidden bg-gray-900 border-b border-gray-800">
				<div className="container mx-auto px-4 py-3">
					<div className="flex gap-2">
						<button
							onClick={showOrdersPage}
							className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors ${
								currentPage === "orders" ? "bg-white text-black" : "text-gray-300"
							}`}>
							<Package className="w-4 h-4" />
							Orders
						</button>
						<button
							onClick={() => setCurrentPage("create-order")}
							className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors ${
								currentPage === "create-order"
									? "bg-white text-black"
									: "text-gray-300"
							}`}>
							<Plus className="w-4 h-4" />
							New
						</button>
					</div>
				</div>
			</div>

			<main className="container mx-auto px-4 py-8">
				{currentPage === "orders" && (
					<div>
						<div className="flex items-center justify-between mb-8">
							<div>
								<h2 className="text-3xl font-bold text-white">
									Treatment Orders
								</h2>
								<p className="text-gray-400">
									Manage and track all orthodontic appliance orders
								</p>
							</div>
							<button
								onClick={() => setCurrentPage("create-order")}
								className="bg-white text-black px-6 py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200 flex items-center gap-2">
								<Plus className="w-5 h-5" />
								New Order
							</button>
						</div>

						<div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-8">
							<div className="flex flex-col md:flex-row gap-4">
								<div className="flex-1 relative">
									<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
									<input
										ref={orderSearchRef}
										onChange={(e) => handleSearchChange(e.target.value)}
										type="text"
										placeholder="Search orders..."
										className="w-full pl-10 pr-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
									/>
								</div>
								<div className="flex gap-2">
									<select
										ref={orderFilterRef}
										defaultValue="All Status"
										onChange={(e) => handleStatusChange(e.target.value)}
										className="px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white">
										<option className="bg-gray-900">All Status</option>
										<option className="bg-gray-900">Pending</option>
										<option className="bg-gray-900">In Progress</option>
										<option className="bg-gray-900">Shipped</option>
										<option className="bg-gray-900">Completed</option>
									</select>
								</div>
							</div>
						</div>

						<div className="grid gap-6">
							{orders.map((order) => {
								const orderFiles = getOrderFiles(order);
								const isExpanded = expandedOrderId === order.order_id;

								return (
									<div
										key={order.order_id}
										className="relative bg-gray-900 rounded-xl border border-gray-800 p-6 hover:border-gray-600 transition-colors duration-200"
										onMouseEnter={() =>
											setHoveredOrder(order.order_id)
										}
										onMouseLeave={() => setHoveredOrder(null)}>
										{hoveredOrder === order.order_id && (
											<button
												onClick={() =>
													setDeleteOrderId(order.order_id)
												}
												className="absolute top-3 left-3 p-2 rounded-full hover:bg-gray-800 transition-colors">
												<Trash2 className="w-5 h-5 text-red-500" />
											</button>
										)}

										<div className="ml-8 flex items-start justify-between gap-6">
											<div className="flex items-center gap-4">
												<div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center">
													<Package className="w-6 h-6 text-black" />
												</div>
												<div>
													<h3 className="text-lg font-semibold text-white">
														{order.patient}
													</h3>
													<p className="text-gray-400">
														{order.details || order.type}
													</p>
													<p className="text-sm text-gray-500">
														Order #{order.order_id} • {getDisplayDate(order)}
													</p>
												</div>
											</div>

											<div className="flex items-center gap-4">
												<div className="text-right">
													<span
														className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(
															order.status,
														)}`}>
														{getStatusIcon(order.status)}
														{order.status
															.replace("-", " ")
															.toUpperCase()}
													</span>
													<div className="mt-2 w-32 bg-gray-700 rounded-full h-2">
														<div
															className={`h-2 rounded-full transition-all duration-300 ${
																order.status === "completed"
																	? "bg-green-500"
																	: order.status === "in-progress"
																		? "bg-blue-500"
																		: order.status === "shipped"
																			? "bg-purple-500"
																			: "bg-yellow-500"
															}`}
															style={{
																width: `${order.progress}%`,
															}}
														/>
													</div>
													<p className="text-sm text-gray-500 mt-1">
														{order.progress}% Complete
													</p>
												</div>

												<button
													type="button"
													onClick={() =>
														toggleOrderExpanded(order.order_id)
													}
													className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:border-gray-500 hover:text-white transition-colors">
													{isExpanded ? "Hide details" : "View details"}
													<ChevronDown
														className={`h-4 w-4 transition-transform ${
															isExpanded ? "rotate-180" : ""
														}`}
													/>
												</button>
											</div>
										</div>

										{isExpanded && (
											<div className="mt-6 ml-8 rounded-xl border border-gray-800 bg-black/40 p-5">
												<div className="grid gap-5 md:grid-cols-2">
													<div className="space-y-3">
														<div>
															<p className="text-xs uppercase tracking-[0.2em] text-gray-500">
																Patient Name
															</p>
															<p className="mt-1 text-sm text-white">
																{order.patient}
															</p>
														</div>
														<div>
															<p className="text-xs uppercase tracking-[0.2em] text-gray-500">
																Details
															</p>
															<p className="mt-1 text-sm leading-6 text-gray-300">
																{order.details ||
																	"No additional details yet."}
															</p>
														</div>
													</div>

													<div>
														<p className="text-xs uppercase tracking-[0.2em] text-gray-500">
															Attached Files
														</p>
														<p className="mt-1 text-sm text-gray-400">
															{orderFiles.length} file
															{orderFiles.length === 1 ? "" : "s"}
														</p>

														<div className="mt-4 space-y-3">
															{orderFiles.length > 0 ? (
																orderFiles.map((attachment) => (
																	<div
																		key={attachment.id}
																		className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/70 px-4 py-3">
																		<div className="flex min-w-0 items-center gap-3">
																			<div className="rounded-lg bg-gray-800 p-2 text-gray-300">
																				<FileText className="h-4 w-4" />
																			</div>
																			<div className="min-w-0">
																				<p className="truncate text-sm text-white">
																					{attachment.name}
																				</p>
																				<p className="text-xs text-gray-500">
																					{attachment.isLocal
																						? "Ready to download in this session"
																						: "Frontend placeholder download"}
																				</p>
																			</div>
																		</div>

																		<button
																			type="button"
																			onClick={() =>
																				handleDownloadFile(
																					order,
																					attachment,
																				)
																			}
																			className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-200">
																			<Download className="h-4 w-4" />
																			Download
																		</button>
																	</div>
																))
															) : (
																<div className="rounded-lg border border-dashed border-gray-800 px-4 py-6 text-sm text-gray-500">
																	No files attached to this order yet.
																</div>
															)}
														</div>
													</div>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				)}

				{currentPage === "create-order" && (
					<div>
						<div className="mb-8">
							<h2 className="text-3xl font-bold text-white mb-2">
								Create New Order
							</h2>
							<p className="text-gray-400">
								Enter patient details and appliance information
							</p>
						</div>

						<div className="bg-gray-900 rounded-xl border border-gray-800 p-8 max-w-2xl mx-auto">
							<form
								onSubmit={handleCreateOrder}
								className="space-y-6">
								<div>
									<label className="block text-sm font-medium text-gray-300 mb-2">
										Patient Name
									</label>
									<input
										type="text"
										value={newOrder.patient}
										onChange={(e) =>
											setNewOrder({
												...newOrder,
												patient: e.target.value,
											})
										}
										className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
										placeholder="Enter patient full name"
										required
									/>
								</div>

								<div>
									<label className="block text-sm font-medium text-gray-300 mb-2">
										Details
									</label>
									<input
										type="text"
										value={newOrder.details}
										onChange={(e) =>
											setNewOrder({
												...newOrder,
												details: e.target.value,
											})
										}
										className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
										placeholder="Enter type"
										required
									/>
								</div>

								<div>
									<label className="block text-sm font-medium text-gray-300 mb-2">
										Due date
									</label>
									<input
										type="date"
										value={newOrder.dueDate}
										onChange={(e) =>
											setNewOrder({
												...newOrder,
												dueDate: e.target.value,
											})
										}
										className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
										required
									/>
								</div>

								<div>
									<label className="block text-sm font-medium text-gray-300 mb-2">
										Attach Files
									</label>

									<label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-700 rounded-lg cursor-pointer hover:border-white transition">
										<span className="text-gray-400 text-sm">
											Click or drag files
										</span>
										<input
											type="file"
											multiple
											onChange={(e) => {
												const selected = Array.from(
													e.target.files || [],
												);
												setFiles((previous) => [
													...previous,
													...selected,
												]);
											}}
											className="hidden"
										/>
									</label>

									<div className="mt-3 space-y-2">
										{files.map((file, index) => (
											<div
												key={`${file.name}-${index}`}
												className="flex items-center justify-between bg-gray-900 px-3 py-2 rounded-lg">
												<span className="text-sm text-white truncate">
													{file.name}
												</span>

												<button
													type="button"
													onClick={() =>
														setFiles((previous) =>
															previous.filter(
																(_, currentIndex) =>
																	currentIndex !== index,
															),
														)
													}
													className="text-gray-400 hover:text-red-500 text-sm">
													X
												</button>
											</div>
										))}
									</div>
								</div>

								<div className="flex gap-4">
									<button
										type="submit"
										className="flex-1 bg-white text-black py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200">
										Create Order
									</button>
									<button
										type="button"
										onClick={showOrdersPage}
										className="flex-1 bg-gray-700 text-white py-3 rounded-lg font-semibold hover:bg-gray-600 transition-colors duration-200">
										Cancel
									</button>
								</div>
							</form>
						</div>
					</div>
				)}
			</main>
		</div>
	);
}

export const metadata = {
	title: "ProjectO - Orders",
	description: "A website for managing orders in orthodontics.",
};
