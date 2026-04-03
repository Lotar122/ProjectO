import KratosLogin from "./login";

import { redirect } from "next/navigation";

function setCurrentPage(page)
{
    redirect(`/${page}`);
}

export default async function Page()
{
  return <KratosLogin setCurrentPage={setCurrentPage}/>;
};
 
export const metadata = {
  title: 'ProjectO - Login',
  description:
    'A website for managing orders in orthodontics.',
};
