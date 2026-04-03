import LoginRoute from "./loginClientWrapper";

export default async function Page() {
	return <LoginRoute />;
}

export const metadata = {
	title: "ProjectO - Login",
	description: "A website for managing orders in orthodontics.",
};
