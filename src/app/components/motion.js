// Framer-motion presets. Spread onto a motion element: <motion.div {...DIALOG_PANEL} />.
// Only opacity and transform are animated; reduced motion is handled by the caller's MotionConfig.

export const DIALOG_BACKDROP = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { duration: 0.15, ease: "easeOut" },
};

export const DIALOG_PANEL = {
	initial: { opacity: 0, scale: 0.97 },
	animate: { opacity: 1, scale: 1, transition: { type: "tween", duration: 0.2, ease: "easeOut" } },
	exit: { opacity: 0, scale: 0.97, transition: { type: "tween", duration: 0.15, ease: "easeIn" } },
};

export const SECTION_ENTER = {
	initial: { opacity: 0, y: 8 },
	animate: { opacity: 1, y: 0 },
	transition: { duration: 0.2, ease: "easeOut" },
};
