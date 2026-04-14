"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	CheckCircle,
	ChevronDown,
	Clock,
	Download,
	Ellipsis,
	FileText,
	FolderCog,
	LogOut,
	Package,
	Paperclip,
	Plus,
	Search,
	Trash2,
	Upload,
	UserCircle,
	XCircle,
	PencilLine
} from "lucide-react";
import axios from "axios";

const INITIAL_ORDER = {
	patient: "",
	details: "",
	dueDate: new Date().toISOString().split("T")[0],
};

const INITIAL_EDIT_DRAFT = {
	patient: "",
	details: "",
	dueDate: "",
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

const getOrderFiles = (order, fileNamesById) => {
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

const sectionTransition = {
	initial: { opacity: 0, y: 24 },
	animate: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
	},
};

export default function Orders({ userName, userLastName }) {
	const [currentPage, setCurrentPage] = useState("orders");
	const [allOrders, setAllOrders] = useState([]);
	const [orders, setOrders] = useState([]);
	const [newOrder, setNewOrder] = useState(INITIAL_ORDER);
	const [files, setFiles] = useState([]);
	const [deleteOrderId, setDeleteOrderId] = useState(null);
	const [editedOrder, setEditedOrder] = useState(null);
	const [editDraft, setEditDraft] = useState(INITIAL_EDIT_DRAFT);
	const [expandedOrderId, setExpandedOrderId] = useState(null);
	const [fileNamesById, setFileNamesById] = useState({});
	const [openEditMenuId, setOpenEditMenuId] = useState(null);
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
		setAllOrders(nextOrders);
		syncVisibleOrders(nextOrders);
		return nextOrders;
	}, [syncVisibleOrders]);

	useEffect(() => {
		void refreshOrders();
	}, [refreshOrders]);

	useEffect(() => {
		if (!editedOrder) {
			setEditDraft(INITIAL_EDIT_DRAFT);
			return;
		}

		setEditDraft({
			patient: editedOrder.patient || "",
			details: editedOrder.details || editedOrder.type || "",
			dueDate: getDisplayDate(editedOrder),
		});
	}, [editedOrder]);

	useEffect(() => {
		const missingFileIds = [
			...new Set(
				allOrders
					.flatMap((order) => (Array.isArray(order.files) ? order.files : []))
					.filter((fileId) => fileId && !fileNamesById[fileId]),
			),
		];

		if (missingFileIds.length === 0) {
			return;
		}

		let isMounted = true;

		const loadFileNames = async () => {
			try {
				const responses = await Promise.all(
					missingFileIds.map(async (fileId) => {
						const response = await axios.get(
							`/api/getFileName?file_id=${fileId}`,
							{
								withCredentials: true,
							},
						);

						return [fileId, response.data.filename];
					}),
				);

				if (!isMounted) {
					return;
				}

				setFileNamesById((current) => {
					const next = { ...current };

					responses.forEach(([fileId, filename]) => {
						next[fileId] = filename || current[fileId] || "Attachment";
					});

					return next;
				});
			} catch (err) {
				console.error("Failed to load file names:", err);
			}
		};

		void loadFileNames();

		return () => {
			isMounted = false;
		};
	}, [allOrders, fileNamesById]);

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
		setOpenEditMenuId(null);
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
		setOpenEditMenuId(null);
		setExpandedOrderId((current) => (current === orderId ? null : orderId));
	};

	const openEditOrder = (order) => {
		setEditedOrder(order);
		setOpenEditMenuId(null);
		setCurrentPage("edit-order");
	};

	const handleEditOrderSave = (e) => {
		e.preventDefault();

		if (!editedOrder?.order_id) {
			return;
		}

		const updatedOrder = {
			...editedOrder,
			patient: editDraft.patient,
			details: editDraft.details,
			dueDate: editDraft.dueDate,
			due_date: editDraft.dueDate,
		};

		const nextOrders = allOrders.map((order) =>
			order.order_id === editedOrder.order_id ? updatedOrder : order,
		);

		setAllOrders(nextOrders);
		syncVisibleOrders(nextOrders);
		setEditedOrder(updatedOrder);
		setExpandedOrderId(updatedOrder.order_id);
		setCurrentPage("orders");
	};

	const handleDownloadFile = async (order, attachment, index) => {
		let fileId = attachment.fileId;

		if (!fileId) {
			const refreshedOrders = await refreshOrders();
			const refreshedOrder = refreshedOrders.find(
				(currentOrder) => currentOrder.order_id === order.order_id,
			);
			fileId = refreshedOrder?.files?.[index];
		}

		if (!fileId) {
			return;
		}

		const link = document.createElement("a");
		link.href = `/api/downloadFile?file_id=${fileId}`;
		link.setAttribute("download", "");
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.45 }}
			className="min-h-screen bg-transparent text-white">
			<AnimatePresence>
				{deleteOrderId && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
						<motion.div
							initial={{ opacity: 0, scale: 0.94, y: 18 }}
							animate={{ opacity: 1, scale: 1, y: 0 }}
							exit={{ opacity: 0, scale: 0.96 }}
							className="w-80 rounded-xl bg-gray-900 p-6">
							<h2 className="mb-4 text-lg font-semibold text-white">
								Delete Order?
							</h2>
							<p className="mb-6 text-gray-400">
								Are you sure you want to delete this order? This action cannot be
								undone.
							</p>
							<div className="flex justify-end gap-4">
								<button
									onClick={() => setDeleteOrderId(null)}
									className="rounded bg-gray-700 px-4 py-2 transition-colors hover:bg-gray-600">
									Cancel
								</button>
								<button
									onClick={confirmDelete}
									className="rounded bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-500">
									Delete
								</button>
							</div>
						</motion.div>
					</div>
				)}
			</AnimatePresence>

			<motion.header
				initial={{ opacity: 0, y: -18 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.45 }}
				className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-[0_12px_40px_rgba(255,255,255,0.12)]">
								<Package className="h-6 w-6 text-black" />
							</div>
							<h1 className="text-2xl font-bold text-white">ProjectO</h1>
						</div>

						<nav className="hidden items-center gap-6 md:flex">
							<button
								onClick={showOrdersPage}
								className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
									currentPage === "orders"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Package className="h-4 w-4" />
								Orders
							</button>
							<button
								onClick={() => setCurrentPage("create-order")}
								className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
									currentPage === "create-order"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Plus className="h-4 w-4" />
								New Order
							</button>
						</nav>

						<div className="flex items-center gap-4">
							<div className="hidden items-center gap-2 text-sm text-gray-300 md:flex">
								<UserCircle className="h-5 w-5" />
								Dr. {userLastName || userName}
							</div>
							<button
								onClick={handleLogout}
								className="flex items-center gap-2 px-4 py-2 text-gray-300 transition-colors hover:text-white">
								<LogOut className="h-4 w-4" />
								Logout
							</button>
						</div>
					</div>
				</div>
			</motion.header>

			<div className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl md:hidden">
				<div className="container mx-auto px-4 py-3">
					<div className="flex gap-2">
						<button
							onClick={showOrdersPage}
							className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition-colors ${
								currentPage === "orders"
									? "bg-white text-slate-950"
									: "text-slate-300"
							}`}>
							<Package className="h-4 w-4" />
							Orders
						</button>
						<button
							onClick={() => setCurrentPage("create-order")}
							className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition-colors ${
								currentPage === "create-order"
									? "bg-white text-slate-950"
									: "text-slate-300"
							}`}>
							<Plus className="h-4 w-4" />
							New
						</button>
					</div>
				</div>
			</div>

			<main className="container mx-auto px-4 py-8">
				{currentPage === "orders" && (
					<motion.div variants={sectionTransition} initial="initial" animate="animate">
						<div className="mb-8 flex items-center justify-between">
							<div>
								<h2 className="text-3xl font-bold text-white">
									Treatment Orders
								</h2>
								<p className="text-slate-400">
									Manage and track all orthodontic appliance orders
								</p>
							</div>
							<motion.button
								whileHover={{ scale: 1.02, y: -2 }}
								whileTap={{ scale: 0.985 }}
								onClick={() => setCurrentPage("create-order")}
								className="flex items-center gap-2 rounded-lg bg-white px-6 py-3 font-semibold text-black transition-colors duration-200 hover:bg-gray-200">
								<Plus className="h-5 w-5" />
								New Order
							</motion.button>
						</div>

						<motion.div
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.45, delay: 0.05 }}
							className="mb-8 rounded-xl border border-slate-800 bg-slate-900/85 p-6 backdrop-blur">
							<div className="flex flex-col gap-4 md:flex-row">
								<div className="relative flex-1">
									<Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
									<input
										ref={orderSearchRef}
										onChange={(e) => handleSearchChange(e.target.value)}
										type="text"
										placeholder="Search orders..."
										className="w-full rounded-lg border border-slate-700 bg-slate-950 py-3 pl-10 pr-4 text-slate-100 transition-all duration-300 placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
									/>
								</div>
								<div className="flex gap-2">
									<select
										ref={orderFilterRef}
										defaultValue="All Status"
										onChange={(e) => handleStatusChange(e.target.value)}
										className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none">
										<option className="bg-slate-950 text-slate-100">All Status</option>
										<option className="bg-slate-950 text-slate-100">Pending</option>
										<option className="bg-slate-950 text-slate-100">In Progress</option>
										<option className="bg-slate-950 text-slate-100">Shipped</option>
										<option className="bg-slate-950 text-slate-100">Completed</option>
									</select>
								</div>
							</div>
						</motion.div>

						<div className="grid gap-6">
								{orders.map((order) => {
									const orderFiles = getOrderFiles(order, fileNamesById);
									const isExpanded = expandedOrderId === order.order_id;

								return (
									<motion.div
										key={order.order_id}
										initial={{ opacity: 0, y: 22 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
										whileHover={{ y: -4 }}
										className="relative rounded-xl border border-slate-800 bg-slate-900/88 p-6 backdrop-blur transition-colors duration-200 hover:border-slate-700">
										<div className="flex items-start justify-between gap-6">
											<div className="flex items-center gap-4">
												<div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white shadow-[0_10px_30px_rgba(255,255,255,0.12)]">
													<Package className="h-6 w-6 text-black" />
												</div>
												<div>
													<h3 className="text-lg font-semibold text-white">
														{order.patient}
													</h3>
													<p className="text-slate-300">
														{order.details || order.type}
													</p>
													<p className="text-sm text-slate-500">
														Order #{order.order_id} • {getDisplayDate(order)}
													</p>
												</div>
											</div>

											<div className="flex items-center gap-4">
												<div className="text-right">
													<span
														className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium ${getStatusColor(
															order.status,
														)}`}>
														{getStatusIcon(order.status)}
														{order.status
															.replace("-", " ")
															.toUpperCase()}
													</span>
													<div className="mt-2 h-2 w-32 rounded-full bg-slate-700">
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
													<p className="mt-1 text-sm text-slate-500">
														{order.progress}% Complete
													</p>
												</div>

												<button
													type="button"
													onClick={() =>
														toggleOrderExpanded(order.order_id)
													}
													className="inline-flex items-center gap-2 self-start rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white">
													{isExpanded ? "Hide details" : "View details"}
													<ChevronDown
														className={`h-4 w-4 transition-transform ${
															isExpanded ? "rotate-180" : ""
														}`}
													/>
												</button>

												<div className="relative self-start">
													<button
														type="button"
														onClick={() =>
															setOpenEditMenuId((current) =>
																current === order.order_id
																	? null
																	: order.order_id,
															)
														}
														className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
														aria-label={`Open actions for order ${order.order_id}`}>
														<Ellipsis className="h-4 w-4" />
													</button>

													<AnimatePresence>
														{openEditMenuId === order.order_id && (
															<motion.div
																initial={{ opacity: 0, y: 8, scale: 0.98 }}
																animate={{ opacity: 1, y: 0, scale: 1 }}
																exit={{ opacity: 0, y: 8, scale: 0.98 }}
																transition={{ duration: 0.18 }}
																className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-slate-800 bg-slate-950 p-2 shadow-2xl">
																<button
																	type="button"
																	onClick={() => openEditOrder(order)}
																	className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-900 hover:text-white">
																	<PencilLine className="h-4 w-4" />
																	Edit order
																</button>
																<button
																	type="button"
																	onClick={() => {
																		setOpenEditMenuId(null);
																		setExpandedOrderId(order.order_id);
																	}}
																	className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200">
																	<FolderCog className="h-4 w-4" />
																	File management
																</button>
																<button
																	type="button"
																	onClick={() => {
																		setOpenEditMenuId(null);
																		setDeleteOrderId(order.order_id);
																	}}
																	className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200">
																	<Trash2 className="h-4 w-4" />
																	Delete order
																</button>
																<p className="px-3 pb-1 pt-2 text-xs text-slate-500">
																	File actions are UI-only for now.
																</p>
															</motion.div>
														)}
													</AnimatePresence>
												</div>
											</div>
										</div>

										<AnimatePresence initial={false}>
											{isExpanded && (
												<motion.div
													initial={{ opacity: 0, height: 0, y: -8 }}
													animate={{ opacity: 1, height: "auto", y: 0 }}
													exit={{ opacity: 0, height: 0, y: -8 }}
													transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
													className="overflow-hidden">
													<div className="mt-6 ml-8 rounded-xl border border-slate-800 bg-slate-950 p-5 backdrop-blur">
														<div className="grid gap-5 md:grid-cols-2">
															<div className="space-y-3">
																<div>
																	<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
																		Patient Name
																	</p>
																	<p className="mt-1 text-sm text-white">
																		{order.patient}
																	</p>
																</div>
																<div>
																	<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
																		Details
																	</p>
																	<p className="mt-1 text-sm leading-6 text-slate-300">
																		{order.details ||
																			"No additional details yet."}
																	</p>
																</div>
															</div>

																<div>
																	<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
																		Attached Files
																	</p>
																	<p className="mt-1 text-sm text-slate-400">
																		{orderFiles.length} file
																		{orderFiles.length === 1 ? "" : "s"}
																	</p>

																	<div className="mt-4 rounded-lg border border-dashed border-slate-800 bg-slate-900/70 p-4">
																		<div className="flex flex-wrap items-center gap-2">
																			<button
																				type="button"
																				className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white">
																				<Upload className="h-4 w-4" />
																				Upload file
																			</button>
																			<button
																				type="button"
																				className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white">
																				<Paperclip className="h-4 w-4" />
																				Link existing file
																			</button>
																		</div>
																		<p className="mt-3 text-xs text-slate-500">
																			File management UI is prepared here, but no upload,
																			replace, or remove behavior is connected yet.
																		</p>
																	</div>

																	<div className="mt-4 space-y-3">
																		{orderFiles.length > 0 ? (
																		orderFiles.map((attachment, index) => (
																			<motion.div
																				key={attachment.id}
																				initial={{ opacity: 0, y: 10 }}
																				animate={{ opacity: 1, y: 0 }}
																				className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
																				<div className="flex min-w-0 items-center gap-3">
																					<div className="rounded-lg bg-slate-800 p-2 text-slate-300">
																						<FileText className="h-4 w-4" />
																					</div>
																					<div className="min-w-0">
																						<p className="truncate text-sm text-white">
																							{attachment.name}
																						</p>
																						<p className="text-xs text-slate-500">
																							{"Ready to download in this session"}
																						</p>
																					</div>
																				</div>

																				<button
																					type="button"
																					onClick={() =>
																						handleDownloadFile(
																							order,
																							attachment,
																							index
																						)
																					}
																					className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-200">
																					<Download className="h-4 w-4" />
																					Download
																				</button>
																			</motion.div>
																		))
																	) : (
																		<div className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-sm text-slate-500">
																			No files attached to this order yet.
																		</div>
																	)}
																</div>
															</div>
														</div>
													</div>
												</motion.div>
											)}
										</AnimatePresence>
									</motion.div>
								);
							})}
						</div>
					</motion.div>
				)}

				{currentPage === "create-order" && (
					<motion.div variants={sectionTransition} initial="initial" animate="animate">
						<div className="mb-8">
							<h2 className="mb-2 text-3xl font-bold text-white">
								Create New Order
							</h2>
							<p className="text-slate-400">
								Enter patient details and appliance information
							</p>
						</div>

						<div className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900/88 p-8 backdrop-blur">
							<form onSubmit={handleCreateOrder} className="space-y-6">
								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
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
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										placeholder="Enter patient full name"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
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
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										placeholder="Enter type"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
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
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
										Attach Files
									</label>

									<label className="flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/60 transition hover:border-slate-500">
										<span className="text-sm text-slate-400">
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
												className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
												<span className="truncate text-sm text-slate-100">
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
													className="text-sm text-slate-400 hover:text-red-400">
													X
												</button>
											</div>
										))}
									</div>
								</div>

								<div className="flex gap-4">
									<motion.button
										type="submit"
										whileHover={{ scale: 1.02, y: -1 }}
										whileTap={{ scale: 0.985 }}
										className="flex-1 rounded-lg bg-white py-3 font-semibold text-black transition-colors duration-200 hover:bg-gray-200">
										Create Order
									</motion.button>
									<button
										type="button"
										onClick={showOrdersPage}
										className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold text-white transition-colors duration-200 hover:bg-slate-700">
										Cancel
									</button>
								</div>
							</form>
						</div>
					</motion.div>
				)}

				{currentPage === "edit-order" && editedOrder && (
					<motion.div variants={sectionTransition} initial="initial" animate="animate">
						<div className="mb-8">
							<h2 className="mb-2 text-3xl font-bold text-white">Edit Order</h2>
							<p className="text-slate-400">
								Update order details on the frontend for order #
								{editedOrder.order_id}
							</p>
						</div>

						<div className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900/88 p-8 backdrop-blur">
							<form onSubmit={handleEditOrderSave} className="space-y-6">
								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
										Patient Name
									</label>
									<input
										type="text"
										value={editDraft.patient}
										onChange={(e) =>
											setEditDraft((current) => ({
												...current,
												patient: e.target.value,
											}))
										}
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										placeholder="Enter patient full name"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
										Details
									</label>
									<input
										type="text"
										value={editDraft.details}
										onChange={(e) =>
											setEditDraft((current) => ({
												...current,
												details: e.target.value,
											}))
										}
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										placeholder="Enter type"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
										Due date
									</label>
									<input
										type="date"
										value={editDraft.dueDate}
										onChange={(e) =>
											setEditDraft((current) => ({
												...current,
												dueDate: e.target.value,
											}))
										}
										className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
										required
									/>
								</div>

								<div>
									<label className="mb-2 block text-sm font-medium text-slate-300">
										File Management
									</label>

									<label className="flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/60 transition hover:border-slate-500">
										<span className="text-sm text-slate-400">
											Upload or replace files later
										</span>
										<span className="mt-1 text-xs text-slate-500">
											UI only for now, no functionality connected
										</span>
									</label>

									<div className="mt-3 space-y-2">
										<button
											type="button"
											className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-left">
											<span className="flex items-center gap-2 text-sm text-slate-100">
												<Upload className="h-4 w-4" />
												Upload replacement file
											</span>
											<span className="text-xs text-slate-500">Not connected</span>
										</button>
										<button
											type="button"
											className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-left">
											<span className="flex items-center gap-2 text-sm text-slate-100">
												<Paperclip className="h-4 w-4" />
												Add supporting file
											</span>
											<span className="text-xs text-slate-500">Not connected</span>
										</button>
										{getOrderFiles(editedOrder, fileNamesById).map((attachment) => (
											<div
												key={attachment.id}
												className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
												<span className="flex min-w-0 items-center gap-2 text-sm text-slate-100">
													<FileText className="h-4 w-4 shrink-0 text-slate-400" />
													<span className="truncate">{attachment.name}</span>
												</span>
												<span className="text-xs text-slate-500">Available</span>
											</div>
										))}
										{getOrderFiles(editedOrder, fileNamesById).length === 0 && (
											<div className="rounded-lg border border-dashed border-slate-800 px-3 py-5 text-sm text-slate-500">
												No files attached to this order yet.
											</div>
										)}
									</div>
								</div>

								<div className="flex gap-4">
									<motion.button
										type="submit"
										whileHover={{ scale: 1.02, y: -1 }}
										whileTap={{ scale: 0.985 }}
										className="flex-1 rounded-lg bg-white py-3 font-semibold text-black transition-colors duration-200 hover:bg-gray-200">
										Save Changes
									</motion.button>
									<button
										type="button"
										onClick={showOrdersPage}
										className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold text-white transition-colors duration-200 hover:bg-slate-700">
										Cancel
									</button>
								</div>
							</form>
						</div>
					</motion.div>
				)}
			</main>
		</motion.div>
	);
}

export const metadata = {
	title: "ProjectO - Orders",
	description: "A website for managing orders in orthodontics.",
};
