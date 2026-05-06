"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useState } from "react";
import Login from "../login/login";
import PerfProfiler from "../components/perf/PerfProfiler";
import { getPerfFlags } from "../components/perf/perfFlags";
import Landing from "./landing";

export default function Main()
{
	const [currentPage, setCurrentPage] = useState("landing");
	const { disableMotion } = getPerfFlags();
	const resolvedPageTransition = disableMotion
		? {
				initial: { opacity: 1, y: 0, filter: "none" },
				animate: {
					opacity: 1,
					y: 0,
					filter: "none",
					transition: { duration: 0 },
				},
				exit: {
					opacity: 1,
					y: 0,
					filter: "none",
					transition: { duration: 0 },
				},
			}
		: {
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

	return (
		<MotionConfig reducedMotion={disableMotion ? "always" : "never"}>
			<PerfProfiler id="MainPage">
				<div className="relative min-h-screen overflow-hidden bg-transparent">
					<AnimatePresence mode="wait">
						<motion.div
							key={currentPage}
							variants={resolvedPageTransition}
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
			</PerfProfiler>
		</MotionConfig>
	);
}
