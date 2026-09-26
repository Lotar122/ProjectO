import ProtectedPage from "./ordersServerWrapper";

const Page = () =>
{
	return <ProtectedPage />;
};

export const metadata = {
	title: "ProjectO - Zamówienia",
	description: "System do zarządzania zamówieniami ortodontycznymi.",
};

export default Page;
