"use server";

// app/protected/page.tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import Orders from './orders';

import { getUserAuthSession } from '../server-functions/getUserAuthSession';

export default async function ProtectedPage() {
  let cookieHeader = await cookies(); // get cookies from request

  let userAuthSession = await getUserAuthSession(cookieHeader);

  console.log(userAuthSession);

  if(userAuthSession.loggedIn)
  {
    return (<Orders />);
  }
  //else redirect("/");
}
