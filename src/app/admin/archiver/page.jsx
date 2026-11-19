import AdminPageHeader from "../components/AdminPageHeader";
import ArchiverPanel from "../components/ArchiverPanel";
import { requireAdminSession } from "../requireAdminSession";

export const metadata = {
	title: "Archiwizacja",
	description: "Kompresuj pliki starszych zleceń, aby oszczędzać miejsce na dysku.",
};

export default async function AdminArchiverPage()
{
	await requireAdminSession();

	return (
		<>
			<AdminPageHeader
				title="Archiwizacja"
				description="Kompresuj pliki starszych zleceń, aby oszczędzać miejsce na dysku."
			/>
			<ArchiverPanel />
		</>
	);
}
