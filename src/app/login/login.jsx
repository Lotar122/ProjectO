"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import axios from "axios";
import PasswordField from "../components/passwordField";
import Loading from "../pages/loading";

const KRATOS_PUBLIC = "https://orto.lotar122.dev/kratos";

const container = {
	hidden: {},
	show: {
		transition: {
			staggerChildren: 0.08,
			delayChildren: 0.05,
		},
	},
};

const item = {
	hidden: { opacity: 0, y: 22 },
	show: {
		opacity: 1,
		y: 0,
		transition: {
			duration: 0.5,
			ease: [0.22, 1, 0.36, 1],
		},
	},
};

const KratosLogin = ({ setCurrentPage }) =>
{
	const [flow, setFlow] = useState(null);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState(null);
	const router = useRouter();

	useEffect(() =>
	{
		let isMounted = true;

		const initFlow = async () =>
		{
			try {
				await axios.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
					withCredentials: true,
				});
				router.push("/orders");
				return;
			} catch (err) {
				if (err.response?.status !== 401)
				{
					if (isMounted)
					{
						setError(
							err.response?.data?.error || "Failed to check session.",
						);
					}
					return;
				}
			}

			try {
				const response = await axios.get(
					`${KRATOS_PUBLIC}/self-service/login/browser?refresh=true`,
					{ withCredentials: true },
				);

				if (isMounted)
				{
					setFlow(response.data);
				}
			} catch (err) {
				if (isMounted)
				{
					setError(
						err.response?.data?.error || "Failed to fetch login flow.",
					);
				}
			}
		};

		void initFlow();

		return () =>
		{
			isMounted = false;
		};
	}, [router]);

	const handleLogin = async (e) =>
	{
		e.preventDefault();

		if (!flow)
		{
			return;
		}

		try {
			const csrf = flow.ui.nodes.find(
				(node) => node.attributes.name === "csrf_token",
			)?.attributes.value;

			await axios.post(
				flow.ui.action,
				{
					method: "password",
					identifier: email,
					password,
					csrf_token: csrf,
				},
				{ withCredentials: true },
			);

			setError(null);
			router.push("/orders");
		} catch (err) {
			console.error(err);
			setError(err.response?.data?.error || "Login failed.");
		}
	};

	if (!flow)
	{
		return <Loading />;
	}

	return (
		<div className="relative flex min-h-screen items-center justify-center p-4">
			<motion.div
				variants={container}
				initial="hidden"
				animate="show"
				className="relative z-10 w-full max-w-md rounded-[28px] border border-slate-700/80 bg-slate-900/80 p-8 shadow-[0_24px_100px_rgba(0,0,0,0.45)] backdrop-blur-xl">
				<motion.div variants={item} className="mb-8 text-center">
					<h2 className="mb-2 text-3xl font-bold text-white">Welcome Back</h2>
					<p className="text-slate-400">
						Sign in to the dashboard
					</p>
				</motion.div>

				{error && (
					<motion.p
						initial={{ opacity: 0, y: -8 }}
						animate={{ opacity: 1, y: 0 }}
						className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-center text-red-300">
						{error}
					</motion.p>
				)}

				<motion.form variants={item} onSubmit={handleLogin} className="space-y-6">
					<div>
						<label className="mb-2 block text-sm font-medium text-slate-300">
							Email Address
						</label>
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-all duration-300 focus:border-sky-300/60 focus:ring-2 focus:ring-sky-200/20 focus:outline-none"
							placeholder="Enter your email"
							required
						/>
					</div>

					<PasswordField password={password} setPassword={setPassword} />

					<motion.button
						type="submit"
						whileHover={{ scale: 1.02, y: -1 }}
						whileTap={{ scale: 0.985 }}
						className="w-full rounded-xl bg-sky-100 py-3 font-semibold text-slate-950 shadow-[0_14px_40px_rgba(125,211,252,0.14)] transition-colors duration-200 hover:bg-sky-200">
						Sign In
					</motion.button>
				</motion.form>

				<motion.div variants={item} className="mt-6 text-center">
					<button
						onClick={() => setCurrentPage("landing")}
						className="font-medium text-slate-200 transition-colors hover:text-white">
						{"<-"} Back to Home
					</button>
				</motion.div>
			</motion.div>
		</div>
	);
};

export default KratosLogin;
