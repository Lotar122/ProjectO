"use client";

import { useEffect } from "react";
import { getPerfFlags } from "./perfFlags";

const SESSION_GAP_MS = 140;
const ACTIVE_SCROLL_WINDOW_MS = 160;
const LAYOUT_READ_WARN_THRESHOLD = 20;
const MAIN_THREAD_WARN_MS = 24;

const getTargetLabel = (target) =>
{
	if (target === window)
	{
		return "window";
	}

	if (target === document)
	{
		return "document";
	}

	if (target === document.documentElement)
	{
		return "documentElement";
	}

	if (target === document.body)
	{
		return "body";
	}

	if (target instanceof Element)
	{
		return target.tagName.toLowerCase();
	}

	return "unknown";
};

const isPassiveScrollListener = (options) =>
{
	if (options === undefined || options === null)
	{
		return false;
	}

	if (typeof options === "boolean")
	{
		return false;
	}

	return Boolean(options.passive);
};

const getSessionSummary = (state) =>
{
	const frameCount = state.sessionFrameDeltas.length;
	const droppedFrames = state.sessionFrameDeltas.filter((delta) => delta > 16.7).length;
	const jankyFrames = state.sessionFrameDeltas.filter((delta) => delta > 33.3).length;
	const frozenFrames = state.sessionFrameDeltas.filter((delta) => delta > 50).length;
	const worstFrame = frameCount > 0 ? Math.max(...state.sessionFrameDeltas) : 0;
	const averageDelta =
		frameCount > 0
			? state.sessionFrameDeltas.reduce((sum, delta) => sum + delta, 0) / frameCount
			: 0;

	return {
		frameCount,
		averageDeltaMs: Number(averageDelta.toFixed(2)),
		worstFrameMs: Number(worstFrame.toFixed(2)),
		droppedFrames,
		jankyFrames,
		frozenFrames,
		layoutReads: state.sessionLayoutReads,
		longTasks: state.sessionLongTasks.map((duration) => Number(duration.toFixed(2))),
		reactCommitsDuringScroll: state.sessionReactCommits.length,
		maxReactCommitMs:
			state.sessionReactCommits.length > 0
				? Number(
					Math.max(
						...state.sessionReactCommits.map((commit) => commit.actualDuration),
					).toFixed(2),
				)
				: 0,
		scrollListenerRegistrations: state.scrollListenerRegistrations,
	};
};

const incrementLayoutRead = (state, label) =>
{
	if (!state.isScrollActive)
	{
		return;
	}

	state.sessionLayoutReads[label] = (state.sessionLayoutReads[label] || 0) + 1;

	if (state.sessionLayoutReads[label] === LAYOUT_READ_WARN_THRESHOLD)
	{
		console.info("[perf] repeated layout read during scroll", {
			label,
			count: state.sessionLayoutReads[label],
		});
	}
};

export default function ScrollPerfDiagnostics()
{
	useEffect(() =>
	{
		const flags = getPerfFlags();

		if (!flags.debug || typeof window === "undefined")
		{
			return undefined;
		}

		const root = document.documentElement;
		const originalAddEventListener = EventTarget.prototype.addEventListener;
		const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
		const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
		const originalGetComputedStyle = window.getComputedStyle.bind(window);
		const listenerMap = new WeakMap();
		const cleanupCallbacks = [];
		const state = {
			isScrollActive: false,
			lastScrollAt: 0,
			lastAnimationFrameAt: 0,
			sessionFrameDeltas: [],
			sessionLayoutReads: {},
			sessionLongTasks: [],
			sessionReactCommits: [],
			scrollListenerRegistrations: [],
		};
		let scrollEndTimeoutId = null;
		let animationFrameId = null;

		root.dataset.perfDebug = "true";
		root.dataset.perfDisableMotion = flags.disableMotion ? "true" : "false";
		root.dataset.perfDisableVisualEffects = flags.disableVisualEffects
			? "true"
			: "false";
		root.dataset.perfDisableScrollListeners = flags.disableScrollListeners
			? "true"
			: "false";

		console.info("[perf] diagnostics enabled", flags);

		const endScrollSession = () =>
		{
			if (!state.isScrollActive)
			{
				return;
			}

			state.isScrollActive = false;
			state.lastAnimationFrameAt = 0;
			console.info("[perf] scroll session summary", getSessionSummary(state));
			state.sessionFrameDeltas = [];
			state.sessionLayoutReads = {};
			state.sessionLongTasks = [];
			state.sessionReactCommits = [];
		};

		const tick = (timestamp) =>
		{
			if (state.lastAnimationFrameAt > 0 && state.isScrollActive)
			{
				const delta = timestamp - state.lastAnimationFrameAt;
				state.sessionFrameDeltas.push(delta);

				if (delta > MAIN_THREAD_WARN_MS)
				{
					console.info("[perf] slow frame during scroll", {
						deltaMs: Number(delta.toFixed(2)),
					});
				}
			}

			state.lastAnimationFrameAt = timestamp;

			if (
				state.isScrollActive ||
				performance.now() - state.lastScrollAt < ACTIVE_SCROLL_WINDOW_MS
			)
			{
				animationFrameId = window.requestAnimationFrame(tick);
			} else
			{
				animationFrameId = null;
			}
		};

		const beginScrollSession = () =>
		{
			state.lastScrollAt = performance.now();

			if (!state.isScrollActive)
			{
				state.isScrollActive = true;
				state.lastAnimationFrameAt = 0;
				state.sessionFrameDeltas = [];
				state.sessionLayoutReads = {};
				state.sessionLongTasks = [];
				state.sessionReactCommits = [];
			}

			if (scrollEndTimeoutId)
			{
				window.clearTimeout(scrollEndTimeoutId);
			}

			scrollEndTimeoutId = window.setTimeout(endScrollSession, SESSION_GAP_MS);

			if (animationFrameId === null)
			{
				animationFrameId = window.requestAnimationFrame(tick);
			}
		};

		const reportCommit = (commit) =>
		{
			if (!state.isScrollActive)
			{
				return;
			}

			state.sessionReactCommits.push(commit);

			if (commit.actualDuration > 8)
			{
				console.info("[perf] React commit during scroll", {
					id: commit.id,
					phase: commit.phase,
					actualDurationMs: Number(commit.actualDuration.toFixed(2)),
					baseDurationMs: Number(commit.baseDuration.toFixed(2)),
				});
			}
		};

		window.__PROJECTO_PERF_REPORT_COMMIT__ = reportCommit;

		const longTaskObserver =
			typeof PerformanceObserver !== "undefined"
				? new PerformanceObserver((entryList) =>
				{
					entryList.getEntries().forEach((entry) =>
					{
						if (!state.isScrollActive)
						{
							return;
						}

						state.sessionLongTasks.push(entry.duration);
						console.info("[perf] long task during scroll", {
							durationMs: Number(entry.duration.toFixed(2)),
							name: entry.name,
						});
					});
				})
				: null;

		if (longTaskObserver)
		{
			try {
				longTaskObserver.observe({
					entryTypes: ["longtask"],
				});
				cleanupCallbacks.push(() => longTaskObserver.disconnect());
			} catch (error) {
				console.info("[perf] longtask observer unavailable", error);
			}
		}

		EventTarget.prototype.addEventListener = function patchedAddEventListener(
			type,
			listener,
			options,
		)
		{
			if (type !== "scroll" || listener == null)
			{
				return originalAddEventListener.call(this, type, listener, options);
			}

			const registration = {
				target: getTargetLabel(this),
				passive: isPassiveScrollListener(options),
			};
			state.scrollListenerRegistrations.push(registration);
			console.info("[perf] scroll listener registered", registration);

			if (
				flags.disableScrollListeners &&
				(this === window ||
					this === document ||
					this === document.documentElement ||
					this === document.body)
			)
			{
				console.info("[perf] scroll listener disabled by flag", registration);
				return undefined;
			}

			const wrappedListener =
				typeof listener === "function"
					? function wrappedScrollListener(event)
					{
						const startedAt = performance.now();

						try {
							return listener.call(this, event);
						} finally {
							const duration = performance.now() - startedAt;

							if (duration > 4)
							{
								console.info("[perf] slow scroll listener", {
									target: registration.target,
									durationMs: Number(duration.toFixed(2)),
								});
							}
						}
					}
					: {
						handleEvent(event)
						{
							const startedAt = performance.now();

							try {
								return listener.handleEvent(event);
							} finally {
								const duration = performance.now() - startedAt;

								if (duration > 4)
								{
									console.info("[perf] slow scroll listener", {
										target: registration.target,
										durationMs: Number(duration.toFixed(2)),
									});
								}
							}
						},
					};

			listenerMap.set(listener, wrappedListener);
			return originalAddEventListener.call(this, type, wrappedListener, options);
		};

		EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(
			type,
			listener,
			options,
		)
		{
			if (type !== "scroll" || listener == null)
			{
				return originalRemoveEventListener.call(this, type, listener, options);
			}

			return originalRemoveEventListener.call(
				this,
				type,
				listenerMap.get(listener) || listener,
				options,
			);
		};

		Element.prototype.getBoundingClientRect = function patchedGetBoundingClientRect()
		{
			incrementLayoutRead(state, "getBoundingClientRect");
			return originalGetBoundingClientRect.call(this);
		};

		window.getComputedStyle = function patchedGetComputedStyle(...args)
		{
			incrementLayoutRead(state, "getComputedStyle");
			return originalGetComputedStyle(...args);
		};

		const patchGetter = (prototype, propertyName) =>
		{
			const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);

			if (!descriptor?.get)
			{
				return;
			}

			Object.defineProperty(prototype, propertyName, {
				...descriptor,
				get()
				{
					incrementLayoutRead(state, propertyName);
					return descriptor.get.call(this);
				},
			});

			cleanupCallbacks.push(() =>
			{
				Object.defineProperty(prototype, propertyName, descriptor);
			});
		};

		[
			"offsetHeight",
			"offsetWidth",
			"offsetTop",
			"offsetLeft",
			"clientHeight",
			"clientWidth",
			"scrollHeight",
			"scrollWidth",
			"scrollTop",
			"scrollLeft",
		].forEach((propertyName) =>
		{
			patchGetter(HTMLElement.prototype, propertyName);
			patchGetter(Element.prototype, propertyName);
		});

		originalAddEventListener.call(window, "scroll", beginScrollSession, {
			passive: true,
			capture: true,
		});

		cleanupCallbacks.push(() =>
		{
			originalRemoveEventListener.call(window, "scroll", beginScrollSession, {
				capture: true,
			});
		});

		const startupSummaryTimeoutId = window.setTimeout(() =>
		{
			if (state.scrollListenerRegistrations.length === 0)
			{
				console.info("[perf] no runtime scroll listeners registered by the app");
			}
		}, 1500);

		return () =>
		{
			window.clearTimeout(startupSummaryTimeoutId);

			if (scrollEndTimeoutId)
			{
				window.clearTimeout(scrollEndTimeoutId);
			}

			if (animationFrameId !== null)
			{
				window.cancelAnimationFrame(animationFrameId);
			}

			delete window.__PROJECTO_PERF_REPORT_COMMIT__;
			delete root.dataset.perfDebug;
			delete root.dataset.perfDisableMotion;
			delete root.dataset.perfDisableVisualEffects;
			delete root.dataset.perfDisableScrollListeners;

			EventTarget.prototype.addEventListener = originalAddEventListener;
			EventTarget.prototype.removeEventListener = originalRemoveEventListener;
			Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
			window.getComputedStyle = originalGetComputedStyle;
			cleanupCallbacks.forEach((callback) => callback());
		};
	}, []);

	return null;
}
