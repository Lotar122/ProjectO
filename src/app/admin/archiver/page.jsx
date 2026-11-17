import AdminPageHeader from "../components/AdminPageHeader";
import ArchiverPanel from "../components/ArchiverPanel";

export const metadata = {
	title: "Archiwizacja",
	description: "Kompresuj pliki starszych zleceń, aby oszczędzać miejsce na dysku.",
};

export default function AdminArchiverPage()
{
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
