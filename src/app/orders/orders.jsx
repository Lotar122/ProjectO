"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import axios from "axios";

import DeleteOrderModal from "./components/DeleteOrderModal";
import OrderCard from "./components/OrderCard";
import OrderForm from "./components/OrderForm";
import OrdersHeader from "./components/OrdersHeader";
import OrdersToolbar from "./components/OrdersToolbar";
import {
	buildOrderFileName,
	INITIAL_EDIT_DRAFT,
	INITIAL_ORDER,
	createLocalAttachments,
	getDisplayDate,
	getFilteredOrders,
	getOrderFiles,
} from "./orderUtils";

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
	const [editFiles, setEditFiles] = useState([]);
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
			setEditFiles([]);
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
			frontendFiles: createLocalAttachments(files, newOrder.patient),
			uploadedFiles: files.map((file, index) => ({
				id: `${file.name}-${index}-${file.size}`,
				name: buildOrderFileName(newOrder.patient, file.name),
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
		setEditedOrder(null);
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
		setEditFiles(getOrderFiles(order, fileNamesById));
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
			frontendFiles: editFiles,
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
		if (attachment.file instanceof File) {
			const objectUrl = URL.createObjectURL(attachment.file);
			const link = document.createElement("a");
			link.href = objectUrl;
			link.download = buildOrderFileName(order.patient, attachment.name);
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(objectUrl);
			return;
		}

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

		const downloadOrder =
			order.patient
				? order
				: allOrders.find((currentOrder) => currentOrder.order_id === order.order_id) ||
					order;
		const response = await axios.get(`/api/downloadFile?file_id=${fileId}`, {
			withCredentials: true,
			responseType: "blob",
		});
		const objectUrl = URL.createObjectURL(response.data);
		const link = document.createElement("a");
		link.href = objectUrl;
		link.download = buildOrderFileName(downloadOrder.patient, attachment.name);
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(objectUrl);
	};

	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.45 }}
			className="min-h-screen bg-transparent text-white">
			<DeleteOrderModal
				isOpen={Boolean(deleteOrderId)}
				onCancel={() => setDeleteOrderId(null)}
				onConfirm={confirmDelete}
			/>

			<OrdersHeader
				currentPage={currentPage}
				onLogout={handleLogout}
				onShowCreateOrder={() => setCurrentPage("create-order")}
				onShowOrders={showOrdersPage}
				userLastName={userLastName}
				userName={userName}
			/>

			<main className="container mx-auto px-4 py-8">
				{currentPage === "orders" && (
					<motion.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
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
							transition={{ duration: 0.45, delay: 0.05 }}>
							<OrdersToolbar
								orderFilterRef={orderFilterRef}
								orderSearchRef={orderSearchRef}
								onSearchChange={handleSearchChange}
								onStatusChange={handleStatusChange}
							/>
						</motion.div>

						<div className="grid gap-6">
							{orders.map((order) => (
								<OrderCard
									key={order.order_id}
									fileNamesById={fileNamesById}
									isExpanded={expandedOrderId === order.order_id}
									isMenuOpen={openEditMenuId === order.order_id}
									onDownloadFile={(attachment, index) =>
										handleDownloadFile(order, attachment, index)
									}
									onOpenEdit={() => openEditOrder(order)}
									onRequestDelete={() => {
										setOpenEditMenuId(null);
										setDeleteOrderId(order.order_id);
									}}
									onToggleExpanded={() => toggleOrderExpanded(order.order_id)}
									onToggleMenu={() =>
										setOpenEditMenuId((current) =>
											current === order.order_id ? null : order.order_id,
										)
									}
									order={order}
								/>
							))}
						</div>
					</motion.div>
				)}

				{currentPage === "create-order" && (
					<motion.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
						<OrderForm
							description="Enter patient details and appliance information"
							details={newOrder.details}
							dueDate={newOrder.dueDate}
							fileSectionMode="create"
							files={files}
							onCancel={showOrdersPage}
							onDetailsChange={(details) =>
								setNewOrder((current) => ({
									...current,
									details,
								}))
							}
							onDueDateChange={(dueDate) =>
								setNewOrder((current) => ({
									...current,
									dueDate,
								}))
							}
							onFilesSelected={(selectedFiles) =>
								setFiles((previous) => [...previous, ...selectedFiles])
							}
							onPatientChange={(patient) =>
								setNewOrder((current) => ({
									...current,
									patient,
								}))
							}
							onRemoveFile={(index) =>
								setFiles((previous) =>
									previous.filter((_, currentIndex) => currentIndex !== index),
								)
							}
							onSubmit={handleCreateOrder}
							patient={newOrder.patient}
							submitLabel="Create Order"
							title="Create New Order"
						/>
					</motion.div>
				)}

				{currentPage === "edit-order" && editedOrder && (
					<motion.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
						<OrderForm
							description={`Update order details on the frontend for order #${editedOrder.order_id}`}
							details={editDraft.details}
							dueDate={editDraft.dueDate}
							fileSectionMode="edit"
							onCancel={showOrdersPage}
							onDetailsChange={(details) =>
								setEditDraft((current) => ({
									...current,
									details,
								}))
							}
							onDueDateChange={(dueDate) =>
								setEditDraft((current) => ({
									...current,
									dueDate,
								}))
							}
							onPatientChange={(patient) =>
								setEditDraft((current) => ({
									...current,
									patient,
								}))
							}
							onFilesSelected={(selectedFiles) =>
								setEditFiles((current) => [
									...current,
									...createLocalAttachments(selectedFiles),
								])
							}
							onRemoveAttachment={(_, index) =>
								setEditFiles((current) =>
									current.filter((_, currentIndex) => currentIndex !== index),
								)
							}
							onSubmit={handleEditOrderSave}
							patient={editDraft.patient}
							submitLabel="Save Changes"
							title="Edit Order"
							attachments={editFiles}
						/>
					</motion.div>
				)}
			</main>
		</motion.div>
	);
}
