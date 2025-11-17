"use server";

// app/protected/page.tsx
import { cookies } from 'next/headers';
import axios from 'axios';

export default async function ProtectedPage({}) {
  let cookieHeader = await cookies(); // get cookies from request
  cookieHeader = cookieHeader.toString();

  let loggedIn = false;
  //try {
    const kratosUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';

    const res = await axios.get(`${kratosUrl}/sessions/whoami`, {
      headers: {
        cookie: cookieHeader,
      },
      withCredentials: true,
    });
    console.log(res, cookieHeader);

    if (res.data && res.data.active) {
      loggedIn = true;
    }
  //} catch (err) {
    //loggedIn = false;
  //}

  return (
    <div>
      {loggedIn ? <h1>Logged In</h1> : <h1>Not Logged In</h1>}
    </div>
  );
}
