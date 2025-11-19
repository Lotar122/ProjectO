import ProtectedPage from "./ordersServerWrapper";

const Page = () => {
  return <ProtectedPage/>;
};
 
export const metadata = {
  title: 'ProjectO',
  description:
    'A website for managing orders in orthodontics.',
};

export default Page;
