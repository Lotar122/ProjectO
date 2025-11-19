import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import OrdersWrapped from './ordersServerWrapper';

import { getUserAuthSession } from '../server-functions/getUserAuthSession';

export default async function ProtectedPage() {
  let cookieHeader = await cookies(); // get cookies from request

  let userAuthSession = await getUserAuthSession(cookieHeader);

  if(userAuthSession.loggedIn)
  {
    return (<OrdersWrapped />);
  }
  else redirect("/");
}

export const metadata = {
  title: 'ProjectO - Orders',
  description:
    'A website for managing orders in orthodontics.',
};
