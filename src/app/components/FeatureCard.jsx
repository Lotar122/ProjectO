import { motion } from "framer-motion";

export default function FeatureCard({ description, icon: Icon, title })
{
	return (
		<motion.div
			whileHover={{ y: -8, scale: 1.01 }}
			transition={{ type: "spring", stiffness: 220, damping: 20 }}
			className="rounded-2xl border border-white/10 bg-white/6 p-8 text-center text-white shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur">
			<div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-black shadow-[0_12px_40px_rgba(255,255,255,0.15)]">
				<Icon className="h-8 w-8" />
			</div>
			<h3 className="mb-3 text-xl font-semibold">{title}</h3>
			<p className="text-gray-300">{description}</p>
		</motion.div>
	);
}
