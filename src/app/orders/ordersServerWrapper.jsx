"use server";

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import Orders from './orders';

import { getUserAuthSession } from '../server-functions/getUserAuthSession';
import { getNameFromEmail } from '../server-functions/getUserName';

export default async function ProtectedPage() {
  let cookieHeader = await cookies(); // get cookies from request

  let userAuthSession = await getUserAuthSession(cookieHeader);

  if(userAuthSession.loggedIn)
  {
    let name = await getNameFromEmail(userAuthSession.data.identity.traits.email);
    return (<Orders userName={name.first} userLastName={name.last} />);
  }
  else redirect("/");
}