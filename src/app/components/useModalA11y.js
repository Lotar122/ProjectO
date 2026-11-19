"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"area[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"iframe",
	"[contenteditable='true']",
	"[tabindex]",
].join(",");

// Dialogs open right now, in the order they opened. Module-level, so stacked dialogs
// from different components agree on which one is on top.
const openDialogs = [];

// The body counts as "nothing focused": Safari does not focus a clicked button.
function canReturnFocusTo(element)
{
	return element instanceof HTMLElement && element.isConnected && element !== document.body;
}

function getFocusableElements(container)
{
	return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
		(element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
	);
}

/**
 * Keyboard behaviour for a modal dialog: initial focus, Escape to close,
 * Tab / Shift+Tab kept inside the dialog, focus returned to the opener on close.
 * Attach the returned ref to the element with role="dialog" and give it tabIndex={-1},
 * so it can take focus itself when it has no focusable content.
 * When the opener is gone by the time the dialog closes (for example an item of a menu
 * that closed when the dialog opened), focus goes to `returnFocusRef` instead; it is read
 * when the dialog opens.
 * @param {{
 *   isOpen: boolean,
 *   onClose?: () => void,
 *   initialFocusRef?: import("react").RefObject<HTMLElement | null>,
 *   returnFocusRef?: import("react").RefObject<HTMLElement | null>,
 * }} options
 * @returns {import("react").RefObject<HTMLElement | null>} ref for the dialog element
 */
export default function useModalA11y({ isOpen, onClose, initialFocusRef, returnFocusRef })
{
	const dialogRef = useRef(null);
	const onCloseRef = useRef(onClose);

	useEffect(() =>
	{
		onCloseRef.current = onClose;
	});

	useEffect(() =>
	{
		const dialog = dialogRef.current;

		if (!isOpen || !dialog)
		{
			return undefined;
		}

		const previouslyFocused = document.activeElement;
		const returnFocusTarget = returnFocusRef?.current;
		const initialTarget = initialFocusRef?.current ?? getFocusableElements(dialog)[0] ?? dialog;
		const entry = {};

		openDialogs.push(entry);
		initialTarget.focus();

		const handleKeyDown = (event) =>
		{
			// Every open dialog listens on document; only the one opened last reacts.
			if (openDialogs.at(-1) !== entry)
			{
				return;
			}

			if (event.key === "Escape")
			{
				if (event.isComposing || event.defaultPrevented)
				{
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				onCloseRef.current?.();
				return;
			}

			if (event.key !== "Tab")
			{
				return;
			}

			const focusable = getFocusableElements(dialog);

			if (focusable.length === 0)
			{
				event.preventDefault();
				dialog.focus();
				return;
			}

			const first = focusable[0];
			const last = focusable.at(-1);
			const active = document.activeElement;
			const isOutside = !dialog.contains(active);

			if (event.shiftKey && (isOutside || active === first || active === dialog))
			{
				event.preventDefault();
				last.focus();
			}
			else if (!event.shiftKey && (isOutside || active === last))
			{
				event.preventDefault();
				first.focus();
			}
		};

		// Capture phase, so Escape does not also reach page-level listeners such as header menus.
		document.addEventListener("keydown", handleKeyDown, true);

		return () =>
		{
			document.removeEventListener("keydown", handleKeyDown, true);
			openDialogs.splice(openDialogs.indexOf(entry), 1);

			if (canReturnFocusTo(previouslyFocused))
			{
				previouslyFocused.focus();
			}
			else if (canReturnFocusTo(returnFocusTarget))
			{
				returnFocusTarget.focus();
			}

			// The dialog may still be on screen for its exit animation; keep Enter and Space
			// from pressing its buttons again when there was nowhere to send focus back to.
			if (dialog.contains(document.activeElement))
			{
				document.activeElement.blur();
			}
		};
	}, [isOpen, initialFocusRef, returnFocusRef]);

	return dialogRef;
}
