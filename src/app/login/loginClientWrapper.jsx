"use client";

import KratosLogin from "./login";
import { useRouter } from "next/navigation";

export default function LoginRoute() {
  let router = useRouter();

  function routerRedirect(page)
  {
    router.push(`/${page}`);
  }

  <KratosLogin setCurrentPage={routerRedirect} />
}