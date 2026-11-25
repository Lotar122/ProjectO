"use client";

import { m } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import http, { isAbortError } from "@/app/lib/http";
import { SECTION_ENTER } from "@/app/components/motion";
import Alert from "../components/Alert";
import PasswordField from "../components/passwordField";
import Loading from "../loading";
import { KRATOS_PUBLIC, getKratosFlowMessages, getKratosNodeValue } from "../lib/kratos";

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

			// The session cookie is set at this point, so a failing whoami must not look like a failed login.
			let destination = "/";

			try
			{
				const sessionResponse = await http.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
					withCredentials: true,
					signal,
				});

				destination = getPostLoginPath(sessionResponse.data);
			}
			catch (whoamiError)
			{
				if (isAbortError(whoamiError) && signal?.aborted)
				{
					return;
				}

				console.error("Nie udało się pobrać sesji po zalogowaniu:", whoamiError);
			}

			// Stays disabled while navigating; the flow is consumed anyway.
			navigated = true;
			router.push(destination);
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
						className="w-full max-w-md space-y-5 rounded-xl border border-line bg-surface p-6 shadow-popover sm:p-8">
						<Alert tone="danger">{String(error)}</Alert>
						<button
							type="button"
							onClick={retry}
							className="btn btn-primary w-full">
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
				{...SECTION_ENTER}
				className="relative z-10 w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-popover sm:p-8">
				<div className="mb-6 text-center sm:mb-8">
					<h1 className="mb-2 text-2xl font-bold text-foreground sm:text-3xl">Witaj ponownie</h1>
					<p className="text-muted">
						Zaloguj się do panelu
					</p>
				</div>

				{error && (
					<Alert tone="danger" className="mb-4">{String(error)}</Alert>
				)}

				<form
					onSubmit={handleLogin}
					method="post"
					autoComplete="on"
					className="space-y-6">
					<div>
						<label htmlFor="login-username" className="field-label">
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
							className="field"
							placeholder="jan.kowalski@przyklad.pl"
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

					<button
						type="submit"
						disabled={isSubmitting}
						className="btn btn-primary w-full">
						{isSubmitting ? "Logowanie..." : "Zaloguj się"}
					</button>
				</form>
			</m.div>
		</div>
	);
};

export default KratosLogin;
