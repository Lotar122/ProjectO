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
    const res = await axios.get(`${Bun.env.KRATOS_PUBLIC_URL}/sessions/whoami`, {
      headers: {
        cookie: `${cookieHeader.name}=${cookieHeader.value}`,
      },
      withCredentials: false,
    });

	console.log(res.data);

    if (res.data && res.data.active) {
      loggedIn = true;

	  const DB = postgres(Bun.env.DB_URL, {prepare: true});

	  let users = null;
	  try {
		users = await DB`SELECT * FROM users WHERE "UUID" = ${res.data.id}`;
	  }
	  catch(err) {
		console.error(err);
	  }

	  if(users.length == 0)
	  {
		try {
			await DB`
			INSERT INTO users ("UUID", email)
			VALUES (${res.data.id}, ${res.data.identity.traits.email})
			`;
		}
		catch(err) {
			console.error(err);
		}
	  }

	  await DB.end();
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
