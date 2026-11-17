"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Upload } from "lucide-react";

function hasFiles(event)
{
	return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Reads the dropped files synchronously (the DataTransfer is only valid during the event).
 * Directories are skipped and counted, since the browser cannot read them as files.
 * @param {DataTransfer} dataTransfer
 * @returns {{ files: File[], skippedFolders: number }}
 */
function readDroppedFiles(dataTransfer)
{
	const items = Array.from(dataTransfer.items ?? []).filter(
		(item) => item.kind === "file",
	);

	if (items.length === 0)
	{
		return { files: Array.from(dataTransfer.files ?? []), skippedFolders: 0 };
	}

	const files = [];
	let skippedFolders = 0;

	for (const item of items)
	{
		if (item.webkitGetAsEntry?.()?.isDirectory)
		{
			skippedFolders += 1;
			continue;
		}

		const file = item.getAsFile();

		if (file)
		{
			files.push(file);
		}
	}

	return { files, skippedFolders };
}

function describeAdded(count)
{
	if (count === 1)
	{
		return "Dodano 1 plik.";
	}

	const lastDigit = count % 10;
	const lastTwoDigits = count % 100;
	const isFew = lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14);

	return `Dodano ${count} ${isFew ? "pliki" : "plików"}.`;
}

export default function FileDropzone({
	hint,
	label,
	onFilesSelected,
})
{
	const id = useId();
	const inputRef = useRef(null);
	const dragDepth = useRef(0);
	const [isDragging, setIsDragging] = useState(false);
	const [notice, setNotice] = useState({ text: "", isWarning: false });

	const buttonId = `${id}-button`;
	const textId = `${id}-text`;
	const hintId = `${id}-hint`;
	const noticeId = `${id}-notice`;

	useEffect(() =>
	{
		// Without this, a file released just outside the zone would open in the tab.
		function guard(event)
		{
			if (hasFiles(event))
			{
				event.preventDefault();
			}
		}

		function guardDrop(event)
		{
			guard(event);
			dragDepth.current = 0;
			setIsDragging(false);
		}

		window.addEventListener("dragover", guard);
		window.addEventListener("drop", guardDrop);

		return () =>
		{
			window.removeEventListener("dragover", guard);
			window.removeEventListener("drop", guardDrop);
		};
	}, []);

	function resetDrag()
	{
		dragDepth.current = 0;
		setIsDragging(false);
	}

	function handleDragEnter(event)
	{
		if (!hasFiles(event))
		{
			return;
		}

		event.preventDefault();
		dragDepth.current += 1;
		setIsDragging(true);
	}

	function handleDragOver(event)
	{
		if (!hasFiles(event))
		{
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}

	function handleDragLeave(event)
	{
		if (!hasFiles(event))
		{
			return;
		}

		event.preventDefault();
		dragDepth.current = Math.max(0, dragDepth.current - 1);

		if (dragDepth.current === 0)
		{
			setIsDragging(false);
		}
	}

	function handleDrop(event)
	{
		if (!hasFiles(event))
		{
			return;
		}

		event.preventDefault();
		resetDrag();

		const { files, skippedFolders } = readDroppedFiles(event.dataTransfer);

		if (files.length > 0)
		{
			onFilesSelected?.(files);
		}

		if (skippedFolders > 0)
		{
			setNotice({
				text: "Foldery nie są obsługiwane. Przeciągnij pojedyncze pliki.",
				isWarning: true,
			});
		}
		else
		{
			setNotice({
				text: files.length > 0 ? describeAdded(files.length) : "",
				isWarning: false,
			});
		}
	}

	function handleInputChange(event)
	{
		const selected = Array.from(event.target.files ?? []);

		// Clearing the value lets the same file be picked again after it was removed.
		event.target.value = "";

		if (selected.length > 0)
		{
			onFilesSelected?.(selected);
		}

		setNotice({
			text: selected.length > 0 ? describeAdded(selected.length) : "",
			isWarning: false,
		});
	}

	return (
		<div>
			<label htmlFor={buttonId} className="field-label">
				{label}
			</label>
			<input
				ref={inputRef}
				type="file"
				multiple
				tabIndex={-1}
				aria-hidden="true"
				onChange={handleInputChange}
				className="sr-only"
			/>
			<button
				id={buttonId}
				type="button"
				aria-describedby={hint ? `${textId} ${hintId}` : textId}
				onClick={() => inputRef.current?.click()}
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				className={`focus-ring flex min-h-32 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-4 text-center transition-colors ${
					isDragging
						? "border-accent-line bg-accent-soft text-foreground"
						: "border-line-control bg-surface-sunken text-muted hover:border-accent-text hover:bg-surface"
				}`}>
				<Upload size={20} aria-hidden="true" className="pointer-events-none" />
				<span id={textId} className="pointer-events-none text-sm">
					{isDragging ? "Upuść pliki, aby je dodać" : "Kliknij lub przeciągnij pliki"}
				</span>
				{hint && (
					<span id={hintId} className={`pointer-events-none text-xs ${isDragging ? "invisible" : ""}`}>
						{hint}
					</span>
				)}
			</button>
			<p
				id={noticeId}
				aria-live="polite"
				className={`mt-2 min-h-5 text-sm ${notice.isWarning ? "text-warning-text" : "text-muted"}`}>
				{notice.text}
			</p>
		</div>
	);
}
