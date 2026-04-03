import { motion } from "framer-motion";

export default function Loading() {
	return (
		<div className="flex min-h-screen items-center justify-center bg-transparent">
			<div className="text-center">
				<motion.div
					animate={{ rotate: 360 }}
					transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }}
					className="mx-auto mb-5 h-24 w-24 rounded-full border-4 border-white/25 border-t-white shadow-[0_0_40px_rgba(255,255,255,0.08)]"
				/>
				<motion.h1
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5 }}
					className="mb-2 text-3xl font-bold text-white">
					ProjectO
				</motion.h1>
				<motion.p
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.08 }}
					className="text-gray-400">
					Orthodontic Management System
				</motion.p>
			</div>
		</div>
	);
}
