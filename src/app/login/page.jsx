import KratosLogin from "./login";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();

  // This is a plain function, no React state
  function setCurrentPage(page) {
    router.push(`/${page}`); // client-side navigation
  }

  return <KratosLogin setCurrentPage={setCurrentPage} />;
}
 
export const metadata = {
  title: 'ProjectO - Login',
  description:
    'A website for managing orders in orthodontics.',
};
