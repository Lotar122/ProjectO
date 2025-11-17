"use server";

// app/protected/page.tsx
import { cookies } from 'next/headers';
import axios from 'axios';

export default async function ProtectedPage({}) {
  const cookieHeader = cookies().toString(); // get cookies from request

  let loggedIn = false;
  try {
    const kratosUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';

    const res = await axios.get(`${kratosUrl}/sessions/whoami`, {
      headers: {
        cookie: cookieHeader,
      },
      withCredentials: true,
    });

    if (res.data && res.data.active) {
      loggedIn = true;
    }
  } catch (err) {
    loggedIn = false;
  }

  return (
    <div>
      {loggedIn ? <h1>Logged In</h1> : <h1>Not Logged In</h1>}
    </div>
  );
}
