import LegalPage from "../legal/LegalPage";
import { PRIVACY } from "../legal/content";

export default function Page()
{
	return <LegalPage doc={PRIVACY} />;
}

export const metadata = {
	title: "ProjectO - Polityka prywatności",
};
