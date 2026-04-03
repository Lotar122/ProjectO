"use client";

import Landing from "./landing";
import Login from "../login/login";
import { useState } from "react";

export default function Main() {
	const [currentPage, setCurrentPage] = useState("landing");

	return (
		<div className="min-h-screen bg-black">
			{currentPage === "login" ? (
				<Login setCurrentPage={setCurrentPage} />
			) : (
				<Landing
					currentPage={currentPage}
					setCurrentPage={setCurrentPage}
				/>
			)}
		</div>
	);
}
