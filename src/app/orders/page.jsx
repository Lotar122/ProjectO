"use server";

// app/protected/page.tsx
import { cookies } from 'next/headers';
import axios from 'axios';
import { redirect } from 'next/navigation';

import postgres from "postgres";

import Orders from './orders';

let ordersArray = [
	{ id: 'ORD-001', patient: 'John Smith', type: 'Invisalign Full', status: 'completed', date: '2023-05-15', progress: 100 },
	{ id: 'ORD-002', patient: 'Sarah Johnson', type: 'Traditional Braces', status: 'in-progress', date: '2023-06-20', progress: 65 },
	{ id: 'ORD-003', patient: 'Mike Davis', type: 'Clear Aligners', status: 'pending', date: '2023-07-10', progress: 20 },
	{ id: 'ORD-004', patient: 'Emily Chen', type: 'Lingual Braces', status: 'shipped', date: '2023-08-05', progress: 90 },
];
let ordersToBeDisplayed = structuredClone(ordersArray);

export default async function ProtectedPage() {
  let cookieHeader = await cookies(); // get cookies from request
  cookieHeader = cookieHeader.get("ory_kratos_session");

  let loggedIn = false;
  try {
    const kratosUrl = 'https://orto.lotar122.dev/kratos/public';

    const res = await axios.get(`${kratosUrl}/sessions/whoami`, {
      headers: {
        cookie: `${cookieHeader.name}=${cookieHeader.value}`,
      },
      withCredentials: false,
    });

    if (res.data && res.data.active) {
      loggedIn = true;

	  console.log("Server side DB access.");

	  const DB = postgres(Bun.env.DB_URL, {prepare: true});

	  console.log(`SELECT * FROM users WHERE UUID = ${res.data.id}`);

	  try {
		const users = await DB`SELECT * FROM users WHERE UUID = ${res.data.id}`;
	  	console.log(users);
	  }
	  catch(err) {
		console.error(err);
	  }
    }
  } catch (err) {
    loggedIn = false;
  }

  if(loggedIn)
  {
    return (<Orders ordersArray={ordersArray} ordersToBeDisplayed={ordersToBeDisplayed} />);
  }
  else redirect("/");
}
