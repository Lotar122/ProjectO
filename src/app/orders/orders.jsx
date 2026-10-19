"use client";

import { m } from "framer-motion";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import http, { TRANSFER_TIMEOUT_MS } from "@/app/lib/http";

import BackgroundActionsWidget from "./components/BackgroundActionsWidget";
import OrderCard from "./components/OrderCard";
import OrdersHeader from "./components/OrdersHeader";
import OrdersPagination from "./components/OrdersPagination";
import OrdersToolbar from "./components/OrdersToolbar";
import {
	KRATOS_PUBLIC,
	getKratosFlowMessages,
	getKratosNodeValue,
} from "@/app/lib/kratos";
import {
	buildOrderFileName,
	INITIAL_EDIT_DRAFT,
	INITIAL_ORDER,
	UPLOAD_LIMIT_MESSAGE,
	appendUploadFiles,
	computeSha256Hex,
	computeSha256HexSequentially,
	createLocalAttachments,
	getChecksumMismatchError,
	getDisplayDate,
	getOrderFiles,
	getUploadLimitError,
	getUploadLimitResponseError,
	normalizeOrderStatus,
} from "./orderUtils";

// Forms and dialogs are rarely open on first paint, so they load on demand.
const OrderForm = dynamic(() => import("./components/OrderForm"));
const PasswordSettingsForm = dynamic(() => import("./components/PasswordSettingsForm"));
const DeleteOrderModal = dynamic(() => import("./components/DeleteOrderModal"));
const IntegrityErrorModal = dynamic(() => import("./components/IntegrityErrorModal"));

const sectionTransition = {
	initial: { opacity: 0 },
	animate: {
		opacity: 1,
		transition: { duration: 0.25 },
	},
};

const INITIAL_PASSWORD_FORM = {
	currentPassword: "",
	newPassword: "",
	confirmPassword: "",
};

const ORDERS_PAGE_SIZE = 25;
const FILE_NAMES_BATCH_SIZE = 100;
const ALL_STATUSES_LABEL = "Wszystkie statusy";
const MAX_CACHED_ORDER_PAGES = 50;
// A background action that is still pending after this long is reported as failed instead of spinning forever.
const ACTION_TIMEOUT_MS = 60000;
const TRANSFER_ACTION_TIMEOUT_MS = TRANSFER_TIMEOUT_MS + ACTION_TIMEOUT_MS;
// Object URLs must outlive the click, or some browsers cancel the download.
const OBJECT_URL_LIFETIME_MS = 60000;

const createOrdersCacheKey = ({ page, search, status }) =>
	JSON.stringify({
		page,
		search: search.trim().toLowerCase(),
		status: normalizeOrderStatus(status),
	});

const UPLOAD_INTEGRITY_MESSAGE =
	"Pliki zostały uszkodzone podczas przesyłania (niezgodna suma kontrolna), również przy ponownej próbie. Spróbuj ponownie później.";

// Retries the upload once when the server reports a checksum mismatch
const sendWithChecksumRetry = async (send) =>
{
	try
	{
		return await send();
	}
	catch (err)
	{
		if (!(await getChecksumMismatchError(err)))
		{
			throw err;
		}

		return send();
	}
};

// Returns the verified blob, or null if it was corrupted in transit twice
const downloadVerifiedFile = async (fileId) =>
{
	for (let attempt = 0; attempt < 2; attempt++)
	{
		const response = await http.get(`/api/downloadFile?file_id=${fileId}`, {
			withCredentials: true,
			responseType: "blob",
			timeout: TRANSFER_TIMEOUT_MS,
		});
		const expectedChecksum = response.headers["x-content-sha256"];
		const actualChecksum = await computeSha256Hex(response.data);

		if (!expectedChecksum || actualChecksum === null || actualChecksum === expectedChecksum)
		{
			return response.data;
		}
	}

	return null;
};

const saveBlob = (blob, fileName) =>
{
	const objectUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");

	link.href = objectUrl;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_LIFETIME_MS);
};

// Same value for every collapsed card, so memoized cards don't see a new prop.
const NO_FILE_NAMES = {};

export default function Orders({
	adminMode = false,
	initialOrdersPayload = null,
	initialPage = "orders",
	isAdmin = false,
	userEmail,
	userName,
	userLastName,
})
{
	const [currentPage, setCurrentPage] = useState(initialPage);
	const [orders, setOrders] = useState(initialOrdersPayload?.orders ?? []);
	const [currentOrdersPage, setCurrentOrdersPage] = useState(initialOrdersPayload?.page ?? 1);
	const [totalOrdersCount, setTotalOrdersCount] = useState(initialOrdersPayload?.totalCount ?? 0);
	const [totalOrdersPages, setTotalOrdersPages] = useState(initialOrdersPayload?.totalPages ?? 1);
	// Starts true when nothing was prefetched, so the empty state doesn't flash before the first load.
	const [isOrdersLoading, setIsOrdersLoading] = useState(
		initialPage === "orders" && !initialOrdersPayload,
	);
	// Committed search text; the text being typed lives in OrdersToolbar.
	const [orderSearchValue, setOrderSearchValue] = useState("");
	const [orderStatusValue, setOrderStatusValue] = useState(ALL_STATUSES_LABEL);
	const [newOrder, setNewOrder] = useState(INITIAL_ORDER);
	const [files, setFiles] = useState([]);
	const [deleteOrderId, setDeleteOrderId] = useState(null);
	const [editedOrder, setEditedOrder] = useState(null);
	const [editDraft, setEditDraft] = useState(INITIAL_EDIT_DRAFT);
	const [editFiles, setEditFiles] = useState([]);
	const [expandedOrderId, setExpandedOrderId] = useState(null);
	const [fileNamesById, setFileNamesById] = useState({});
	const [downloadingFileIds, setDownloadingFileIds] = useState(() => new Set());
	const [backgroundActions, setBackgroundActions] = useState([]);
	const [integrityError, setIntegrityError] = useState(null);
	const [openEditMenuId, setOpenEditMenuId] = useState(null);
	const [statusUpdatingOrderId, setStatusUpdatingOrderId] = useState(null);
	const [passwordForm, setPasswordForm] = useState(INITIAL_PASSWORD_FORM);
	const [passwordChangeError, setPasswordChangeError] = useState(null);
	const [isPasswordChangeSubmitting, setIsPasswordChangeSubmitting] =
		useState(false);
	// Pages already fetched, seeded with the server-rendered one. The Map is mutated in place and never rendered.
	const [ordersCache] = useState(() =>
	{
		const cache = new Map();

		if (initialOrdersPayload)
		{
			cache.set(
				createOrdersCacheKey({
					page: initialOrdersPayload.page,
					search: "",
					status: ALL_STATUSES_LABEL,
				}),
				initialOrdersPayload,
			);
		}

		return cache;
	});
	const backgroundActionTimeoutsRef = useRef({});
	const cacheGenerationRef = useRef(0);
	const latestOrdersRequestRef = useRef(0);
	const ordersAbortRef = useRef(null);
	const fileNameRequestsRef = useRef(new Map());
	const isLoggingOutRef = useRef(false);
	// Always-current values for stable callbacks, so memoized cards keep their props.
	const latestRef = useRef({});

	useEffect(() =>
	{
		latestRef.current = {
			currentOrdersPage,
			fileNamesById,
			orders,
		};
	});

	const updatePasswordForm = useCallback((field, value) =>
	{
		setPasswordForm((current) => ({
			...current,
			[field]: value,
		}));
	}, []);

	const resetPasswordForm = useCallback(() =>
	{
		setPasswordForm(INITIAL_PASSWORD_FORM);
		setPasswordChangeError(null);
		setIsPasswordChangeSubmitting(false);
	}, []);

	const getKratosErrorMessage = useCallback((error, group) =>
	{
		const flowMessages = getKratosFlowMessages(error?.response?.data, group);

		if (flowMessages.length > 0)
		{
			return flowMessages[0];
		}

		return (
			error?.response?.data?.error?.reason ||
			error?.response?.data?.error?.message ||
			error?.response?.data?.message ||
			error?.message ||
			"Podczas zmiany hasła wystąpił błąd."
		);
	}, []);

	const clearActionTimeout = useCallback((key) =>
	{
		const timeoutId = backgroundActionTimeoutsRef.current[key];

		if (timeoutId)
		{
			clearTimeout(timeoutId);
			delete backgroundActionTimeoutsRef.current[key];
		}
	}, []);

	const removeBackgroundAction = useCallback((actionId) =>
	{
		clearActionTimeout(actionId);
		clearActionTimeout(`${actionId}:watchdog`);

		setBackgroundActions((current) =>
			current.filter((action) => action.id !== actionId),
		);
	}, [clearActionTimeout]);

	const scheduleBackgroundActionRemoval = useCallback(
		(actionId, delayMs) =>
		{
			clearActionTimeout(actionId);

			backgroundActionTimeoutsRef.current[actionId] = window.setTimeout(() =>
			{
				removeBackgroundAction(actionId);
			}, delayMs);
		},
		[clearActionTimeout, removeBackgroundAction],
	);

	const updateBackgroundAction = useCallback((actionId, updates) =>
	{
		setBackgroundActions((current) =>
			current.map((action) =>
				action.id === actionId ? { ...action, ...updates } : action,
			),
		);
	}, []);

	const startBackgroundAction = useCallback(
		(title, description, { timeoutMs = ACTION_TIMEOUT_MS } = {}) =>
		{
			const actionId =
				globalThis.crypto?.randomUUID?.() ??
				`${Date.now()}-${Math.random().toString(16).slice(2)}`;

			setBackgroundActions((current) => [
				...current,
				{
					id: actionId,
					title,
					description,
					status: "pending",
				},
			]);

			backgroundActionTimeoutsRef.current[`${actionId}:watchdog`] = window.setTimeout(() =>
			{
				updateBackgroundAction(actionId, {
					description: "Przekroczono czas oczekiwania.",
					status: "error",
				});
				scheduleBackgroundActionRemoval(actionId, 5000);
			}, timeoutMs);

			return actionId;
		},
		[scheduleBackgroundActionRemoval, updateBackgroundAction],
	);

	const completeBackgroundAction = useCallback(
		(actionId, title, description) =>
		{
			clearActionTimeout(`${actionId}:watchdog`);
			updateBackgroundAction(actionId, {
				title,
				description,
				status: "success",
			});
			scheduleBackgroundActionRemoval(actionId, 1800);
		},
		[clearActionTimeout, scheduleBackgroundActionRemoval, updateBackgroundAction],
	);

	const failBackgroundAction = useCallback(
		(actionId, title, description) =>
		{
			clearActionTimeout(`${actionId}:watchdog`);
			updateBackgroundAction(actionId, {
				title,
				description,
				status: "error",
			});
			scheduleBackgroundActionRemoval(actionId, 5000);
		},
		[clearActionTimeout, scheduleBackgroundActionRemoval, updateBackgroundAction],
	);

	const clearOrdersCache = useCallback(() =>
	{
		ordersCache.clear();
		// Requests started before this must not repopulate the cache with stale pages.
		cacheGenerationRef.current += 1;
	}, [ordersCache]);

	const applyOrdersPayload = useCallback((payload) =>
	{
		setOrders(payload.orders || []);
		setTotalOrdersCount(payload.totalCount || 0);
		setTotalOrdersPages(payload.totalPages || 1);
		setCurrentOrdersPage(payload.page || 1);
	}, []);

	const loadOrdersPage = useCallback(
		async ({
			force = false,
			page = latestRef.current.currentOrdersPage ?? 1,
			search = "",
			status = ALL_STATUSES_LABEL,
		} = {}) =>
		{
			const cacheKey = createOrdersCacheKey({
				page,
				search,
				status,
			});
			const requestId = latestOrdersRequestRef.current + 1;

			latestOrdersRequestRef.current = requestId;
			// A newer request replaces whatever is still in flight.
			ordersAbortRef.current?.abort();
			ordersAbortRef.current = null;

			if (!force && ordersCache.has(cacheKey))
			{
				const cachedPayload = ordersCache.get(cacheKey);

				setIsOrdersLoading(false);
				applyOrdersPayload(cachedPayload);
				return cachedPayload.orders || [];
			}

			const controller = new AbortController();
			const cacheGeneration = cacheGenerationRef.current;

			ordersAbortRef.current = controller;
			setIsOrdersLoading(true);

			try
			{
				const params = new URLSearchParams({
					page: String(page),
					limit: String(ORDERS_PAGE_SIZE),
				});

				if (search.trim())
				{
					params.set("search", search.trim());
				}

				if (status !== ALL_STATUSES_LABEL)
				{
					params.set("status", normalizeOrderStatus(status));
				}

				const response = await http.get(
					`${adminMode ? "/api/admin/getOrders" : "/api/getOrders"}?${params.toString()}`,
					{
						withCredentials: true,
						signal: controller.signal,
					},
				);

				const payload = {
					orders: response.data.orders || [],
					page: response.data.page || page,
					pageSize: response.data.pageSize || ORDERS_PAGE_SIZE,
					totalCount: response.data.totalCount || 0,
					totalPages: response.data.totalPages || 1,
				};

				if (cacheGeneration === cacheGenerationRef.current)
				{
					const cache = ordersCache;

					cache.set(
						createOrdersCacheKey({ page: payload.page, search, status }),
						payload,
					);

					if (cache.size > MAX_CACHED_ORDER_PAGES)
					{
						cache.delete(cache.keys().next().value);
					}
				}

				if (requestId === latestOrdersRequestRef.current)
				{
					applyOrdersPayload(payload);
				}

				return payload.orders;
			}
			catch (err)
			{
				// Replaced by a newer request: that one reports the result.
				if (controller.signal.aborted)
				{
					return [];
				}

				throw err;
			}
			finally
			{
				if (requestId === latestOrdersRequestRef.current)
				{
					ordersAbortRef.current = null;
					setIsOrdersLoading(false);
				}
			}
		},
		[adminMode, applyOrdersPayload, ordersCache],
	);

	// Reloads with the filters currently on screen.
	const refreshOrders = useCallback(
		async ({ page } = {}) =>
		{
			clearOrdersCache();
			return loadOrdersPage({
				force: true,
				page,
				search: latestRef.current.search ?? "",
				status: latestRef.current.status ?? ALL_STATUSES_LABEL,
			});
		},
		[clearOrdersCache, loadOrdersPage],
	);

	// Resolves to every file name known after the call (existing plus newly fetched).
	const loadFileNamesByIds = useCallback(async (fileIds, { force = false } = {}) =>
	{
		const known = latestRef.current.fileNamesById ?? {};
		const requests = fileNameRequestsRef.current;
		const wantedIds = [
			...new Set(
				fileIds.filter((fileId) => fileId && (force || !known[fileId])),
			),
		];
		const pending = wantedIds
			.filter((fileId) => requests.has(fileId))
			.map((fileId) => requests.get(fileId));
		const idsToFetch = wantedIds.filter((fileId) => !requests.has(fileId));
		const resolved = {};

		// One batched request per chunk instead of one request per attachment;
		// the per-file fan-out flooded Postgres and Kratos on every page load.
		for (let index = 0; index < idsToFetch.length; index += FILE_NAMES_BATCH_SIZE)
		{
			const chunk = idsToFetch.slice(index, index + FILE_NAMES_BATCH_SIZE);
			const request = http
				.post("/api/getFileNames", { fileIds: chunk }, { withCredentials: true })
				.then((response) =>
				{
					const filenames = response.data?.filenames || {};

					chunk.forEach((fileId) =>
					{
						resolved[fileId] = filenames[fileId] || known[fileId] || "Załącznik";
					});
					setFileNamesById((current) => ({ ...current, ...resolved }));
				})
				.finally(() =>
				{
					chunk.forEach((fileId) => requests.delete(fileId));
				});

			chunk.forEach((fileId) => requests.set(fileId, request));
			pending.push(request);
		}

		await Promise.all(pending);

		return { ...latestRef.current.fileNamesById, ...resolved };
	}, []);

	useEffect(() =>
	{
		// Drop ?view=… once applied so a refresh lands on the orders list.
		if (initialPage !== "orders")
		{
			window.history.replaceState(null, "", window.location.pathname);
		}
	}, [initialPage]);

	useEffect(() =>
	{
		latestRef.current.search = orderSearchValue;
		latestRef.current.status = orderStatusValue;
	}, [orderSearchValue, orderStatusValue]);

	useEffect(() =>
	{
		if (currentPage !== "orders")
		{
			return;
		}

		void loadOrdersPage({
			page: currentOrdersPage,
			search: orderSearchValue,
			status: orderStatusValue,
		}).catch((err) =>
		{
			console.error("Nie udało się pobrać zleceń:", err);
		});
	}, [
		currentOrdersPage,
		currentPage,
		loadOrdersPage,
		orderSearchValue,
		orderStatusValue,
	]);

	useEffect(
		() => () =>
		{
			ordersAbortRef.current?.abort();

			Object.values(backgroundActionTimeoutsRef.current).forEach((timeoutId) =>
			{
				clearTimeout(timeoutId);
			});
		},
		[],
	);

	// File names are only shown in the expanded card, so they load when a card opens.
	useEffect(() =>
	{
		const expandedOrder = orders.find((order) => order.order_id === expandedOrderId);

		if (!Array.isArray(expandedOrder?.files) || expandedOrder.files.length === 0)
		{
			return;
		}

		loadFileNamesByIds(expandedOrder.files).catch((err) =>
		{
			console.error("Nie udało się pobrać nazw plików:", err);
		});
	}, [expandedOrderId, loadFileNamesByIds, orders]);

	const handleLogout = async () =>
	{
		if (isLoggingOutRef.current)
		{
			return;
		}

		isLoggingOutRef.current = true;

		try
		{
			const response = await http.get(`${KRATOS_PUBLIC}/self-service/logout/browser`, {
				withCredentials: true,
			});
			const logoutUrl = response.data?.logout_url;

			if (typeof logoutUrl !== "string" || !logoutUrl)
			{
				throw new Error("Kratos nie zwrócił adresu wylogowania.");
			}

			window.location.href = logoutUrl;
		}
		catch (err)
		{
			isLoggingOutRef.current = false;
			console.error("Błąd wylogowania:", err);
			failBackgroundAction(
				startBackgroundAction("Wylogowanie", userEmail),
				"Nie udało się wylogować",
				"Spróbuj ponownie.",
			);
		}
	};

	const clearEditState = () =>
	{
		setEditedOrder(null);
		setEditDraft(INITIAL_EDIT_DRAFT);
		setEditFiles([]);
	};

	const showChangePasswordPage = () =>
	{
		setOpenEditMenuId(null);
		clearEditState();
		setDeleteOrderId(null);
		setExpandedOrderId(null);
		resetPasswordForm();
		setCurrentPage("change-password");
	};

	const showUploadError = async (err, title) =>
	{
		const checksumMismatch = await getChecksumMismatchError(err);

		if (checksumMismatch)
		{
			setIntegrityError({
				title,
				message: UPLOAD_INTEGRITY_MESSAGE,
				files: checksumMismatch.files,
			});
			return;
		}

		if (await getUploadLimitResponseError(err))
		{
			setIntegrityError({ title, message: UPLOAD_LIMIT_MESSAGE, files: [] });
		}
	};

	const handleCreateOrder = (e) =>
	{
		e.preventDefault();

		if (!newOrder.patient)
		{
			return;
		}

		const selectedFiles = [...files];
		const limitError = getUploadLimitError(selectedFiles);

		if (limitError)
		{
			setIntegrityError({
				title: "Nie udało się utworzyć zlecenia",
				message: limitError,
				files: [],
			});
			return;
		}

		const order = {
			patient: newOrder.patient,
			details: newOrder.details,
			dueDate: newOrder.dueDate,
		};
		const actionId = startBackgroundAction("Tworzenie zlecenia", order.patient, {
			timeoutMs: TRANSFER_ACTION_TIMEOUT_MS,
		});

		setCurrentPage("orders");
		setCurrentOrdersPage(1);
		setNewOrder(INITIAL_ORDER);
		setFiles([]);

		void (async () =>
		{
			let orderID;

			try
			{
				const fileChecksums = await computeSha256HexSequentially(selectedFiles);
				const formData = new FormData();

				formData.append("patient", order.patient);
				formData.append("details", order.details);
				formData.append("dueDate", order.dueDate);
				appendUploadFiles(
					formData,
					selectedFiles.map((file) => ({ file, name: file.name })),
					fileChecksums,
				);

				const response = await sendWithChecksumRetry(() =>
					http.post("/api/postOrder", formData, {
						withCredentials: true,
						timeout: TRANSFER_TIMEOUT_MS,
					}),
				);

				orderID = response.data.orderID;
			}
			catch (err)
			{
				console.error("Nie udało się utworzyć zlecenia:", err);
				failBackgroundAction(actionId, "Nie udało się utworzyć zlecenia", order.patient);
				// Give the data back so the order can be sent again, unless a new one was started meanwhile.
				setNewOrder((current) => (current.patient || current.details ? current : order));
				setFiles((current) => (current.length > 0 ? current : selectedFiles));
				await showUploadError(err, "Nie udało się utworzyć zlecenia");
				return;
			}

			// The order exists now; a failed refresh must not be reported as a failed create.
			try
			{
				await refreshOrders({ page: 1 });
				setExpandedOrderId(orderID);
				completeBackgroundAction(actionId, "Utworzono zlecenie", order.patient);
			}
			catch (err)
			{
				console.error("Nie udało się odświeżyć listy zleceń:", err);
				completeBackgroundAction(
					actionId,
					"Utworzono zlecenie",
					"Odśwież stronę, aby zobaczyć je na liście.",
				);
			}
		})();
	};

	const handleSearchChange = (searchValue) =>
	{
		setOrderSearchValue(searchValue);
		setCurrentOrdersPage(1);
		setExpandedOrderId(null);
		setOpenEditMenuId(null);
	};

	const handleOrderStatusFilterChange = (statusValue) =>
	{
		setOrderStatusValue(statusValue);
		setCurrentOrdersPage(1);
		setExpandedOrderId(null);
		setOpenEditMenuId(null);
	};

	const showOrdersPage = () =>
	{
		setOpenEditMenuId(null);
		clearEditState();
		resetPasswordForm();
		setCurrentPage("orders");
	};

	const handlePasswordChange = async (e) =>
	{
		e.preventDefault();

		const { confirmPassword, currentPassword, newPassword } = passwordForm;

		if (!currentPassword || !newPassword || !confirmPassword)
		{
			setPasswordChangeError("Uzupełnij wszystkie pola hasła.");
			return;
		}

		if (newPassword !== confirmPassword)
		{
			setPasswordChangeError("Potwierdzenie nowego hasła jest niezgodne.");
			return;
		}

		const actionId = startBackgroundAction("Zmiana hasła", userEmail);
		setIsPasswordChangeSubmitting(true);
		setPasswordChangeError(null);

		try
		{
			const refreshFlowResponse = await http.get(
				`${KRATOS_PUBLIC}/self-service/login/browser?refresh=true`,
				{
					withCredentials: true,
				},
			);
			const refreshCsrfToken = getKratosNodeValue(
				refreshFlowResponse.data,
				"csrf_token",
			);

			await http.post(
				refreshFlowResponse.data.ui.action,
				{
					method: "password",
					identifier: userEmail,
					password: currentPassword,
					csrf_token: refreshCsrfToken,
				},
				{
					withCredentials: true,
				},
			);

			const settingsFlowResponse = await http.get(
				`${KRATOS_PUBLIC}/self-service/settings/browser`,
				{
					withCredentials: true,
				},
			);
			const settingsCsrfToken = getKratosNodeValue(
				settingsFlowResponse.data,
				"csrf_token",
			);

			await http.post(
				settingsFlowResponse.data.ui.action,
				{
					method: "password",
					password: newPassword,
					csrf_token: settingsCsrfToken,
				},
				{
					withCredentials: true,
				},
			);

			completeBackgroundAction(actionId, "Hasło zostało zmienione", userEmail);
			showOrdersPage();
		}
		catch (err)
		{
			console.error("Nie udało się zmienić hasła:", err);
			const message = getKratosErrorMessage(err, "password");
			setPasswordChangeError(message);
			failBackgroundAction(actionId, "Nie udało się zmienić hasła", message);
		}
		finally
		{
			setIsPasswordChangeSubmitting(false);
		}
	};

	const confirmDelete = () =>
	{
		if (!deleteOrderId)
		{
			return;
		}

		const orderToDelete = orders.find(
			(order) => order.order_id === deleteOrderId,
		);
		const orderLabel = orderToDelete?.patient || `Zlecenie #${deleteOrderId}`;
		const actionId = startBackgroundAction("Usuwanie zlecenia", orderLabel);
		const orderId = deleteOrderId;

		setDeleteOrderId(null);
		setExpandedOrderId((current) =>
			current === orderId ? null : current,
		);

		void (async () =>
		{
			try
			{
				await http.delete(
					`${adminMode ? "/api/admin/deleteOrder" : "/api/deleteOrder"}?orderID=${orderId}`,
					{
						withCredentials: true,
					},
				);
			}
			catch (err)
			{
				console.error("Nie udało się usunąć zlecenia:", err);
				failBackgroundAction(actionId, "Nie udało się usunąć zlecenia", orderLabel);
				return;
			}

			try
			{
				await refreshOrders({ page: currentOrdersPage });
				completeBackgroundAction(actionId, "Usunięto zlecenie", orderLabel);
			}
			catch (err)
			{
				console.error("Nie udało się odświeżyć listy zleceń:", err);
				completeBackgroundAction(
					actionId,
					"Usunięto zlecenie",
					"Odśwież stronę, aby zobaczyć aktualną listę.",
				);
			}
		})();
	};

	const toggleOrderExpanded = useCallback((orderId) =>
	{
		setOpenEditMenuId(null);
		setExpandedOrderId((current) => (current === orderId ? null : orderId));
	}, []);

	const toggleOrderMenu = useCallback((orderId) =>
	{
		setOpenEditMenuId((current) => (current === orderId ? null : orderId));
	}, []);

	const requestDeleteOrder = useCallback((orderId) =>
	{
		setOpenEditMenuId(null);
		setDeleteOrderId(orderId);
	}, []);

	const openEditOrder = useCallback(async (order) =>
	{
		setOpenEditMenuId(null);

		let names = latestRef.current.fileNamesById ?? {};

		try
		{
			names = await loadFileNamesByIds(order.files ?? []);
		}
		catch (err)
		{
			console.error("Nie udało się pobrać nazw plików:", err);
		}

		setEditFiles(
			getOrderFiles(order, names).map((attachment) => ({
				...attachment,
				initialName: attachment.name,
			})),
		);
		setEditDraft({
			patient: order.patient || "",
			details: order.details || order.type || "",
			dueDate: getDisplayDate(order),
		});
		setEditedOrder(order);
		setCurrentPage("edit-order");
	}, [loadFileNamesByIds]);

	const handleEditOrderSave = (e) =>
	{
		e.preventDefault();

		if (!editedOrder?.order_id)
		{
			return;
		}

		const orderID = editedOrder.order_id;
		const patient = editDraft.patient || editedOrder.patient;
		const details = editDraft.details;
		const dueDate = editDraft.dueDate;
		const attachments = [...editFiles];
		const localAttachments = attachments.filter(
			(attachment) => attachment.isLocal && attachment.file instanceof File,
		);
		const limitError = getUploadLimitError(localAttachments.map((attachment) => attachment.file));

		if (limitError)
		{
			setIntegrityError({
				title: "Nie udało się zapisać zmian w zleceniu",
				message: limitError,
				files: [],
			});
			return;
		}

		// A new patient name changes how every file name is normalized, so then all names are sent.
		const sendAllNames = patient !== editedOrder.patient;
		const actionId = startBackgroundAction("Zapisywanie zmian", patient, {
			timeoutMs: TRANSFER_ACTION_TIMEOUT_MS,
		});

		setCurrentPage("orders");
		clearEditState();

		void (async () =>
		{
			let response;

			try
			{
				const checksums = await computeSha256HexSequentially(
					localAttachments.map((attachment) => attachment.file),
				);
				const formData = new FormData();

				formData.append("orderID", orderID);
				formData.append("patient", patient);
				formData.append("details", details);
				formData.append("dueDate", dueDate);

				attachments.forEach((attachment) =>
				{
					if (!attachment.isLocal && attachment.fileId)
					{
						formData.append("existingFileIds", attachment.fileId);

						if (sendAllNames || attachment.name !== attachment.initialName)
						{
							formData.append(
								"fileNames",
								JSON.stringify({
									fileId: attachment.fileId,
									fileName: attachment.name,
								}),
							);
						}
					}
				});

				appendUploadFiles(formData, localAttachments, checksums);

				response = await sendWithChecksumRetry(() =>
					http.put(
						adminMode ? "/api/admin/modifyOrder" : "/api/modifyOrder",
						formData,
						{
							withCredentials: true,
							timeout: TRANSFER_TIMEOUT_MS,
						},
					),
				);
			}
			catch (err)
			{
				console.error("Nie udało się zaktualizować zlecenia:", err);
				failBackgroundAction(actionId, "Nie udało się zaktualizować zlecenia", patient);
				await showUploadError(err, "Nie udało się zapisać zmian w zleceniu");
				return;
			}

			// The changes are saved; a failed refresh must not be reported as a failed save.
			try
			{
				const updatedOrder = response.data.order;

				if (Array.isArray(response.data.uploadedFiles))
				{
					setFileNamesById((current) =>
					{
						const next = { ...current };

						response.data.uploadedFiles.forEach(({ fileID, fileName }) =>
						{
							next[fileID] = fileName;
						});

						return next;
					});
				}

				const nextOrders = await refreshOrders({ page: currentOrdersPage });
				const refreshedOrder =
					nextOrders.find((order) => order.order_id === updatedOrder.order_id) ||
					updatedOrder;

				const renamedFileIds = attachments
					.filter((attachment) => attachment.fileId)
					.map((attachment) => attachment.fileId);

				if (Array.isArray(refreshedOrder.files) && refreshedOrder.files.length > 0)
				{
					await loadFileNamesByIds(refreshedOrder.files, {
						force: renamedFileIds.length > 0,
					});
				}

				setExpandedOrderId(updatedOrder.order_id);
				completeBackgroundAction(actionId, "Zmiany zapisane", patient);
			}
			catch (err)
			{
				console.error("Nie udało się odświeżyć listy zleceń:", err);
				completeBackgroundAction(
					actionId,
					"Zmiany zapisane",
					"Odśwież stronę, aby zobaczyć aktualną listę.",
				);
			}
		})();
	};

	const handleDownloadFile = useCallback(async (order, attachment, index) =>
	{
		if (attachment.file instanceof File)
		{
			saveBlob(attachment.file, buildOrderFileName(order.patient, attachment.file.name));
			return;
		}

		let fileId = attachment.fileId;

		if (!fileId)
		{
			const refreshedOrders = await refreshOrders({ page: latestRef.current.currentOrdersPage });
			const refreshedOrder = refreshedOrders.find(
				(currentOrder) => currentOrder.order_id === order.order_id,
			);
			fileId = refreshedOrder?.files?.[index];
		}

		if (!fileId)
		{
			return;
		}

		const setDownloading = (isDownloading) =>
		{
			setDownloadingFileIds((current) =>
			{
				const next = new Set(current);

				if (isDownloading)
				{
					next.add(fileId);
				}
				else
				{
					next.delete(fileId);
				}

				return next;
			});
		};

		const downloadOrder =
			order.patient
				? order
				: latestRef.current.orders?.find((currentOrder) => currentOrder.order_id === order.order_id) ||
					order;
		const baseFileName = latestRef.current.fileNamesById?.[fileId] || attachment.name;

		setDownloading(true);

		try
		{
			const fileBlob = await downloadVerifiedFile(fileId);

			if (!fileBlob)
			{
				setIntegrityError({
					title: "Nie udało się pobrać pliku",
					message:
						"Plik został uszkodzony podczas pobierania (niezgodna suma kontrolna), również przy ponownej próbie. Spróbuj ponownie później.",
					files: [baseFileName],
				});
				return;
			}

			saveBlob(fileBlob, buildOrderFileName(downloadOrder.patient, baseFileName));
		}
		catch (err)
		{
			console.error("Nie udało się pobrać pliku:", err);

			if (await getChecksumMismatchError(err))
			{
				setIntegrityError({
					title: "Plik na serwerze jest uszkodzony",
					message:
						"Suma kontrolna zapisanego pliku jest niezgodna z oryginałem. Plik nie został pobrany. Skontaktuj się z administratorem.",
					files: [baseFileName],
				});
				return;
			}

			const actionId = startBackgroundAction("Pobieranie pliku", baseFileName);

			failBackgroundAction(actionId, "Nie udało się pobrać pliku", baseFileName);
		}
		finally
		{
			setDownloading(false);
		}
	}, [failBackgroundAction, refreshOrders, startBackgroundAction]);

	const handleStatusChange = useCallback(async (order, status) =>
	{
		if (!adminMode || !order?.order_id || order.status === status)
		{
			return;
		}

		const actionId = startBackgroundAction("Zmiana statusu zlecenia", order.patient);
		setStatusUpdatingOrderId(order.order_id);

		try
		{
			await http.put(
				"/api/admin/updateOrderStatus",
				{ orderID: order.order_id, status },
				{ withCredentials: true },
			);
		}
		catch (err)
		{
			console.error("Nie udało się zmienić statusu zlecenia:", err);
			failBackgroundAction(actionId, "Nie udało się zmienić statusu zlecenia", order.patient);
			setStatusUpdatingOrderId(null);
			return;
		}

		try
		{
			await refreshOrders({ page: latestRef.current.currentOrdersPage });
			completeBackgroundAction(actionId, "Status zlecenia zmieniony", order.patient);
		}
		catch (err)
		{
			console.error("Nie udało się odświeżyć listy zleceń:", err);
			completeBackgroundAction(
				actionId,
				"Status zlecenia zmieniony",
				"Odśwież stronę, aby zobaczyć aktualną listę.",
			);
		}
		finally
		{
			setStatusUpdatingOrderId(null);
		}
	}, [
		adminMode,
		completeBackgroundAction,
		failBackgroundAction,
		refreshOrders,
		startBackgroundAction,
	]);

	return (
		<div className="min-h-dvh bg-transparent text-white">
			{deleteOrderId && (
				<DeleteOrderModal
					isOpen
					onCancel={() => setDeleteOrderId(null)}
					onConfirm={confirmDelete}
				/>
			)}

			{integrityError && (
				<IntegrityErrorModal
					error={integrityError}
					onClose={() => setIntegrityError(null)}
				/>
			)}

			<OrdersHeader
				currentPage={currentPage}
				isAdmin={isAdmin || adminMode}
				isAdminPage={adminMode}
				onLogout={handleLogout}
				onShowChangePassword={showChangePasswordPage}
				onShowCreateOrder={() => setCurrentPage("create-order")}
				onShowOrders={showOrdersPage}
				userLastName={userLastName}
				userName={userName}
			/>

			<main className="container mx-auto px-4 py-6 sm:py-8">
				{currentPage === "orders" && (
					<m.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
						<div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
							<div className="min-w-0">
								<h2 className="text-2xl font-bold text-white sm:text-3xl">
									{adminMode ? "Wszystkie zlecenia" : "Zlecenia"}
								</h2>
								<p className="text-slate-400">
									{adminMode
										? "Przeglądaj i zarządzaj zleceniami wszystkich użytkowników"
										: "Zarządzaj i śledź wszystkie zlecenia ortodontyczne"}
								</p>
							</div>
							{!adminMode && <button
								type="button"
								onClick={() => setCurrentPage("create-order")}
								className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white px-6 py-3 font-semibold text-black transition-colors duration-200 hover:bg-gray-200 active:scale-[0.985] sm:w-auto">
								<Plus className="h-5 w-5" />
								Nowe zlecenie
							</button>}
						</div>

						<OrdersToolbar
							initialSearchValue={orderSearchValue}
							isAdmin={adminMode}
							onSearchChange={handleSearchChange}
							onStatusChange={handleOrderStatusFilterChange}
							statusValue={orderStatusValue}
						/>

						{/* Fixed height, so showing and hiding the message doesn't move the list. */}
						<p
							className="mb-4 h-5 text-sm text-slate-400"
							aria-live="polite">
							{isOrdersLoading ? "Wczytywanie zleceń..." : ""}
						</p>

						<div
							className={`grid gap-6 transition-opacity duration-200 ${
								isOrdersLoading ? "opacity-60" : "opacity-100"
							}`}>
							{orders.map((order) => (
								<OrderCard
									key={order.order_id}
									downloadingFileIds={expandedOrderId === order.order_id ? downloadingFileIds : undefined}
									fileNamesById={expandedOrderId === order.order_id ? fileNamesById : NO_FILE_NAMES}
									isAdmin={adminMode}
									isExpanded={expandedOrderId === order.order_id}
									isMenuOpen={openEditMenuId === order.order_id}
									isStatusUpdating={statusUpdatingOrderId === order.order_id}
									onDownloadFile={handleDownloadFile}
									onOpenEdit={openEditOrder}
									onRequestDelete={requestDeleteOrder}
									onStatusChange={handleStatusChange}
									onToggleExpanded={toggleOrderExpanded}
									onToggleMenu={toggleOrderMenu}
									order={order}
								/>
							))}
						</div>

						{!isOrdersLoading && orders.length === 0 && (
							<div className="rounded-xl border border-dashed border-slate-700 bg-slate-900 px-6 py-12 text-center text-slate-400">
								Nie znaleziono zleceń dla tej strony lub filtra.
							</div>
						)}

						<OrdersPagination
							currentPage={currentOrdersPage}
							isLoading={isOrdersLoading}
							onPageChange={setCurrentOrdersPage}
							pageSize={ORDERS_PAGE_SIZE}
							totalCount={totalOrdersCount}
							totalPages={totalOrdersPages}
						/>
					</m.div>
				)}

				{currentPage === "create-order" && (
					<m.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
						<OrderForm
							description="Wprowadź dane pacjenta i informacje o aparacie"
							details={newOrder.details}
							detailsRequired={false}
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
									previous.filter(
										(_, currentIndex) => currentIndex !== index,
									),
								)
							}
							onSubmit={handleCreateOrder}
							patient={newOrder.patient}
							submitLabel="Utwórz zlecenie"
							title="Utwórz nowe zlecenie"
						/>
					</m.div>
				)}

				{currentPage === "edit-order" && editedOrder && (
					<m.div
						variants={sectionTransition}
						initial="initial"
						animate="animate">
						<OrderForm
							description={`Zaktualizuj dane i pliki zlecenia #${editedOrder.order_id}`}
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
									...createLocalAttachments(
										selectedFiles,
										editDraft.patient || editedOrder.patient,
									),
								])
							}
							onRemoveAttachment={(_, index) =>
								setEditFiles((current) =>
									current.filter(
										(_, currentIndex) => currentIndex !== index,
									),
								)
							}
							onAttachmentNameChange={(name, attachment) =>
								setEditFiles((current) =>
									current.map((item) =>
										item.id === attachment.id ? { ...item, name } : item,
									),
								)
							}
							onSubmit={handleEditOrderSave}
							patient={editDraft.patient}
							submitLabel="Zapisz zmiany"
							title="Edytuj zlecenie"
							attachments={editFiles}
						/>
					</m.div>
				)}

				{currentPage === "change-password" && (
					<PasswordSettingsForm
						confirmPassword={passwordForm.confirmPassword}
						currentPassword={passwordForm.currentPassword}
						errorMessage={passwordChangeError}
						isSubmitting={isPasswordChangeSubmitting}
						newPassword={passwordForm.newPassword}
						onCancel={showOrdersPage}
						onConfirmPasswordChange={(value) =>
							updatePasswordForm("confirmPassword", value)
						}
						onCurrentPasswordChange={(value) =>
							updatePasswordForm("currentPassword", value)
						}
						onNewPasswordChange={(value) =>
							updatePasswordForm("newPassword", value)
						}
						onSubmit={handlePasswordChange}
					/>
				)}

			</main>

			<BackgroundActionsWidget
				actions={backgroundActions}
				onDismiss={removeBackgroundAction}
			/>
		</div>
	);
}
