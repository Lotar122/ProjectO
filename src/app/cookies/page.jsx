import LegalPage from "../legal/LegalPage";
import { COOKIES } from "../legal/content";

// Operator details come from the environment, so render per request, not at build time.
export const dynamic = "force-dynamic";

export default function Page()
{
	return <LegalPage doc={COOKIES} />;
}

export const metadata = {
	title: "ProjectO - Polityka cookies",
};
