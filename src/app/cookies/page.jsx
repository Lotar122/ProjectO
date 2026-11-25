import LegalPage from "../legal/LegalPage";
import { COOKIES } from "../legal/content";

export default function Page()
{
	return <LegalPage doc={COOKIES} />;
}

export const metadata = {
	title: "ProjectO - Polityka cookies",
};
