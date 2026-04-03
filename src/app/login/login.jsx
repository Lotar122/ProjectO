"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import PasswordField from "../components/passwordField";
import Loading from "../pages/loading";

const KRATOS_PUBLIC = "https://orto.lotar122.dev/kratos";

const KratosLogin = ({ setCurrentPage }) => {
	const [flow, setFlow] = useState(null);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState(null);
	const router = useRouter();

	useEffect(() => {
		let isMounted = true;

		const initFlow = async () => {
			try {
				await axios.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
					withCredentials: true,
				});
				router.push("/orders");
				return;
			} catch (err) {
				if (err.response?.status !== 401) {
					if (isMounted) {
						setError(
							err.response?.data?.error ||
								"Failed to check session.",
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

				if (isMounted) {
					setFlow(response.data);
				}
			} catch (err) {
				if (isMounted) {
					setError(
						err.response?.data?.error ||
							"Failed to fetch login flow.",
					);
				}
			}
		};

		void initFlow();

		return () => {
			isMounted = false;
		};
	}, [router]);

	const handleLogin = async (e) => {
		e.preventDefault();

		if (!flow) {
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

	if (!flow) {
		return <Loading />;
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
				<div className="text-center mb-8">
					<h2 className="text-3xl font-bold text-white mb-2">
						Welcome Back
					</h2>
					<p className="text-gray-400">
						Sign in to your orthodontic dashboard
					</p>
				</div>

				{error && (
					<p className="text-red-500 text-center mb-4">{error}</p>
				)}

				<form onSubmit={handleLogin} className="space-y-6">
					<div>
						<label className="block text-sm font-medium text-gray-300 mb-2">
							Email Address
						</label>
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
							placeholder="Enter your email"
							required
						/>
					</div>

					<PasswordField
						password={password}
						setPassword={setPassword}
					/>

					<button
						type="submit"
						className="w-full bg-white text-black py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200">
						Sign In
					</button>
				</form>

				<div className="mt-6 text-center">
					<button
						onClick={() => setCurrentPage("landing")}
						className="text-white hover:text-gray-300 font-medium">
						{"<-"} Back to Home
					</button>
				</div>
			</div>
		</div>
	);
};

export default KratosLogin;
