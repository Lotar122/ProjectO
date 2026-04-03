"use server";

import LoginRoute from "./loginClientWrapper";

export default function Page() {
  return <LoginRoute />
}
 
export const metadata = {
  title: 'ProjectO - Login',
  description:
    'A website for managing orders in orthodontics.',
};
