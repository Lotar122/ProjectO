"use client";

import { LazyMotion, MotionConfig } from "framer-motion";

// Animation features load after first paint instead of shipping in the main
// bundle; components use the slim `m` element so they can't pull them in.
const loadMotionFeatures = () => import("./motionFeatures").then((module) => module.default);

export default function MotionProvider({ children })
{
	return (
		<MotionConfig reducedMotion="user">
			<LazyMotion features={loadMotionFeatures} strict>
				{children}
			</LazyMotion>
		</MotionConfig>
	);
}
