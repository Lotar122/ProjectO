"use server";

import React from "react";
import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';

import Orders from "./orders";

//import cookie from "cookie";
import { cookies } from "next/headers";

let ordersArray = [
	{ id: 'ORD-001', patient: 'John Smith', type: 'Invisalign Full', status: 'completed', date: '2023-05-15', progress: 100 },
	{ id: 'ORD-002', patient: 'Sarah Johnson', type: 'Traditional Braces', status: 'in-progress', date: '2023-06-20', progress: 65 },
	{ id: 'ORD-003', patient: 'Mike Davis', type: 'Clear Aligners', status: 'pending', date: '2023-07-10', progress: 20 },
	{ id: 'ORD-004', patient: 'Emily Chen', type: 'Lingual Braces', status: 'shipped', date: '2023-08-05', progress: 90 },
];
let ordersToBeDisplayed = structuredClone(ordersArray);

const KRATOS_ADMIN_URL = "http://localhost:4434/kratos/admin";

async function verifySession() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("ory_kratos_session");
  console.log("Cookie.", sessionCookie);

  if (!sessionCookie) return false;

  const sessionId = sessionCookie.value;

  //try {
    const res = await fetch(`${KRATOS_ADMIN_URL}/sessions/${sessionId}`, {
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    console.log(res);

    return res.ok; // true if session exists
  //} catch {
    return false;
  //}
}

export default async function Page() {
  const loggedIn = await verifySession();

  if (!loggedIn) {
    // Redirect from a Server Component
    return (
      <>
        {/* {<meta httpEquiv="refresh" content="0;url=/" />} */}
        <h1>Access denied.</h1>
      </>
    );
  }

  return (
	<Orders ordersArray={ordersArray} ordersToBeDisplayed={ordersToBeDisplayed} />
  );
}