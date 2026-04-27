import { motion } from "framer-motion";
import { Calendar, LogIn, Package, User } from "lucide-react";

import FeatureCard from "../components/FeatureCard";

const container = {
	hidden: {},
	show: {
		transition: {
			staggerChildren: 0.1,
			delayChildren: 0.08,
		},
	},
};

const item = {
	hidden: { opacity: 0, y: 28 },
	show: {
		opacity: 1,
		y: 0,
		transition: {
			duration: 0.55,
			ease: [0.22, 1, 0.36, 1],
		},
	},
};

const cards = [
	{
		title: "Order Management",
		description: "Track and manage all orthodontic appliance orders efficiently",
		icon: Package,
	},
	{
		title: "Progress Tracking",
		description: "Monitor treatment progress and order status in real-time",
		icon: Calendar,
	},
	{
		title: "Patient Care",
		description: "Enhanced patient management and treatment coordination",
		icon: User,
	},
];

export default function Landing({ setCurrentPage })
{
	return (
		<motion.div
			variants={container}
			initial="hidden"
			animate="show"
			className="container mx-auto px-4 py-16 md:py-24">
			<motion.div variants={item} className="text-center mb-16 md:mb-20">
				<motion.div
					initial={{ scale: 0.92, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
					className="mb-6 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 backdrop-blur">
					<span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(74,222,128,0.8)]"></span>
					Orthodontic workflow, elevated
				</motion.div>
				<h1 className="mb-6 bg-gradient-to-b from-white to-gray-400 bg-clip-text text-5xl font-bold text-transparent md:text-7xl">
					ProjectO
				</h1>
				<p className="mx-auto max-w-2xl text-lg text-gray-400 md:text-xl">
					Advanced orthodontic management system for streamlined patient
					care, faster coordination, and order tracking that feels instant.
				</p>
			</motion.div>

			<motion.div
				variants={container}
				className="mb-16 grid gap-8 md:mb-20 md:grid-cols-3">
				{cards.map((card) =>
				{
					return (
						<motion.div key={card.title} variants={item}>
							<FeatureCard
								description={card.description}
								icon={card.icon}
								title={card.title}
							/>
						</motion.div>
					);
				})}
			</motion.div>

			<motion.div variants={item} className="text-center">
				<motion.button
					onClick={() => setCurrentPage("login")}
					whileHover={{ scale: 1.03, y: -2 }}
					whileTap={{ scale: 0.98 }}
					className="mx-auto flex items-center gap-3 rounded-2xl bg-white px-8 py-4 text-lg font-semibold text-black shadow-[0_18px_60px_rgba(255,255,255,0.16)] transition-colors duration-200 hover:bg-gray-200">
					<LogIn className="h-5 w-5" />
					Access Dashboard
				</motion.button>
			</motion.div>
		</motion.div>
	);
}
