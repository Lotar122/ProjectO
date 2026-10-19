"use client";

import { m } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import http, { isAbortError } from "@/app/lib/http";
import PasswordField from "../components/passwordField";
import Loading from "../loading";
import { KRATOS_PUBLIC, getKratosFlowMessages, getKratosNodeValue } from "../lib/kratos";

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

// The role is only trusted from metadata_public (see isAdminSession).
const getPostLoginPath = (session) =>
	session?.identity?.metadata_public?.role === "admin" ? "/admin" : "/orders";

const fetchLoginFlow = async (signal) =>
{
	const response = await http.get(
		`${KRATOS_PUBLIC}/self-service/login/browser?refresh=true`,
		{ withCredentials: true, signal },
	);

	return response.data;
};

// Whatever Kratos (or the network) throws, only a string may reach the JSX.
const getErrorText = (err, fallback) =>
{
	const data = err?.response?.data;
	const flowMessages = getKratosFlowMessages(data);

	if (flowMessages.length > 0)
	{
		return flowMessages.join(" ");
	}

	if (typeof data?.error === "string" && data.error)
	{
		return data.error;
	}

	if (typeof data?.error?.message === "string" && data.error.message)
	{
		return data.error.message;
	}

	return fallback;
};

const KratosLogin = () =>
{
	const [flow, setFlow] = useState(null);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const submittingRef = useRef(false);
	const controllerRef = useRef(null);
	const router = useRouter();

	useEffect(() =>
	{
		const controller = new AbortController();
		const { signal } = controller;

		controllerRef.current = controller;

		// Already signed in: leave. Failures here don't block the form.
		const checkSession = async () =>
		{
			try
			{
				const response = await http.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
					withCredentials: true,
					signal,
				});

				if (!signal.aborted)
				{
					router.push(getPostLoginPath(response.data));
				}
			}
			catch (err)
			{
				if (!isAbortError(err) && err.response?.status !== 401)
				{
					console.error("Nie udało się sprawdzić sesji:", err);
				}
			}
		};

		const loadFlow = async () =>
		{
			try
			{
				const nextFlow = await fetchLoginFlow(signal);

				if (!signal.aborted)
				{
					setFlow(nextFlow);
				}
			}
			catch (err)
			{
				if (!isAbortError(err) || !signal.aborted)
				{
					setError(getErrorText(err, "Nie udało się pobrać formularza logowania."));
				}
			}
		};

		void checkSession();
		void loadFlow();

		return () =>
		{
			controller.abort();
		};
	}, [router, attempt]);

	const retry = () =>
	{
		setError(null);
		setAttempt((value) => value + 1);
	};

	const handleLogin = async (e) =>
	{
		e.preventDefault();

		if (!flow || submittingRef.current)
		{
			return;
		}

		const signal = controllerRef.current?.signal;
		let navigated = false;

		submittingRef.current = true;
		setIsSubmitting(true);

		try 
		{
			const csrf = getKratosNodeValue(flow, "csrf_token");

			await http.post(
				flow.ui.action,
				{
					method: "password",
					identifier: email,
					password,
					csrf_token: csrf,
				},
				{ withCredentials: true, signal },
			);

			setError(null);
			const sessionResponse = await http.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
				withCredentials: true,
				signal,
			});

			// Stays disabled while navigating; the flow is consumed anyway.
			navigated = true;
			router.push(getPostLoginPath(sessionResponse.data));
		}
		catch (err) 
		{
			if (isAbortError(err) && signal?.aborted)
			{
				return;
			}

			console.error("Logowanie nie powiodło się:", err);

			const status = err.response?.status;

			if (status === 410)
			{
				setError(getErrorText(err, "Formularz wygasł. Spróbuj ponownie."));

				try
				{
					setFlow(await fetchLoginFlow(signal));
				}
				catch (refreshError)
				{
					if (!signal?.aborted)
					{
						setError(getErrorText(refreshError, "Nie udało się pobrać formularza logowania."));
					}
				}
			}
			else
			{
				// A rejected login answers 400 with the updated flow (fresh csrf token).
				if (status === 400 && err.response.data?.ui)
				{
					setFlow(err.response.data);
				}

				setError(getErrorText(err, "Logowanie nie powiodło się."));
			}
		}
		finally
		{
			submittingRef.current = navigated;
			setIsSubmitting(navigated);
		}
	};

	if (!flow)
	{
		if (error)
		{
			return (
				<div className="relative flex min-h-dvh items-center justify-center p-4">
					<div
						className="w-full max-w-md rounded-[28px] border border-slate-700/80 bg-slate-900/90 p-6 text-center shadow-lg sm:p-8"
						role="alert">
						<p className="mb-5 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-300">
							{String(error)}
						</p>
						<button
							type="button"
							onClick={retry}
							className="w-full rounded-xl bg-sky-100 py-3 font-semibold text-slate-950 transition-colors duration-200 hover:bg-sky-200">
							Spróbuj ponownie
						</button>
					</div>
				</div>
			);
		}

		return <Loading />;
	}

	return (
		<div className="relative flex min-h-dvh items-center justify-center p-4">
			<m.div
				variants={container}
				initial="hidden"
				animate="show"
				className="relative z-10 w-full max-w-md rounded-[28px] border border-slate-700/80 bg-slate-900/90 p-6 shadow-lg sm:p-8">
				<m.div variants={item} className="mb-6 text-center sm:mb-8">
					<h2 className="mb-2 text-2xl font-bold text-white sm:text-3xl">Witaj ponownie</h2>
					<p className="text-slate-400">
						Zaloguj się do panelu
					</p>
				</m.div>

				{error && (
					<m.p
						initial={{ opacity: 0, y: -8 }}
						animate={{ opacity: 1, y: 0 }}
						role="alert"
						className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-center text-red-300">
						{String(error)}
					</m.p>
				)}

				<m.form
					variants={item}
					onSubmit={handleLogin}
					method="post"
					autoComplete="on"
					className="space-y-6">
					<div>
						<label
							htmlFor="login-username"
							className="mb-2 block text-sm font-medium text-slate-300">
							Adres e-mail
						</label>
						<input
							id="login-username"
							name="username"
							type="email"
							autoComplete="username"
							inputMode="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-white transition-colors duration-300 focus:border-sky-300/60 focus:ring-2 focus:ring-sky-200/20 focus:outline-none"
							placeholder="Wpisz adres e-mail"
							required
						/>
					</div>

					<PasswordField
						id="login-password"
						name="password"
						autoComplete="current-password"
						password={password}
						setPassword={setPassword}
					/>

					<m.button
						type="submit"
						disabled={isSubmitting}
						whileTap={{ scale: 0.985 }}
						className="w-full rounded-xl bg-sky-100 py-3 font-semibold text-slate-950 shadow-md transition-colors duration-200 hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70">
						{isSubmitting ? "Logowanie..." : "Zaloguj się"}
					</m.button>
				</m.form>
			</m.div>
		</div>
	);
};

export default KratosLogin;
