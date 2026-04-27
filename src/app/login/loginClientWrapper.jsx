"use client";

import KratosLogin from "./login";
import { useRouter } from "next/navigation";

export default function LoginRoute()
{
	let router = useRouter();

	function routerRedirect(page)
	{
		if (page == "landing") router.push(`/`);
		else router.push(`/${page}`);
	}

	return <KratosLogin setCurrentPage={routerRedirect} />;
}
