"use server";

// app/protected/page.tsx
import { cookies } from 'next/headers';
import axios from 'axios';
import { redirect } from 'next/dist/server/api-utils';

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
