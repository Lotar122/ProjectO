"use server";

import KratosLogin from "./login";

export default async function Page()
{
  return <KratosLogin/>;
};
 
export const metadata = {
  title: 'ProjectO - Login',
  description:
    'A website for managing orders in orthodontics.',
};
