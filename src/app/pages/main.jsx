"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import Login from "../login/login";
import Landing from "./landing";

const pageTransition = {
	initial: { opacity: 0, y: 20, filter: "blur(8px)" },
	animate: {
		opacity: 1,
		y: 0,
		filter: "blur(0px)",
		transition: {
			duration: 0.55,
			ease: [0.22, 1, 0.36, 1],
		},
	},
	exit: {
		opacity: 0,
		y: -16,
		filter: "blur(6px)",
		transition: {
			duration: 0.32,
			ease: [0.4, 0, 1, 1],
		},
	},
};

export default function Main()
{
	const [currentPage, setCurrentPage] = useState("landing");

	return (
		<div className="relative min-h-screen overflow-hidden bg-transparent">
			<AnimatePresence mode="wait">
				<motion.div
					key={currentPage}
					variants={pageTransition}
					initial="initial"
					animate="animate"
					exit="exit"
					className="relative z-10 min-h-screen">
					{currentPage === "login" ? (
						<Login setCurrentPage={setCurrentPage} />
					) : (
						<Landing
							currentPage={currentPage}
							setCurrentPage={setCurrentPage}
						/>
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
