import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { OPERATOR } from "./operator";

export default function LegalPage({ doc })
{
	return (
		<main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
			<Link href="/login" className="mb-8 inline-flex items-center gap-2 text-sm text-muted hover:text-foreground">
				<ArrowLeft size={16} aria-hidden="true" />
				Wróć do logowania
			</Link>

			<h1 className="text-2xl font-bold text-foreground sm:text-3xl">{doc.title}</h1>
			<p className="mt-2 text-sm text-muted">Obowiązuje od {OPERATOR.updated}</p>

			<div className="mt-6 space-y-3 text-muted">
				{doc.intro.map((text) => <p key={text}>{text}</p>)}
			</div>

			{doc.sections.map((section) => (
				<section key={section.heading} className="mt-8 border-t border-line pt-6">
					<h2 className="mb-3 text-lg font-semibold text-foreground">{section.heading}</h2>
					<div className="space-y-3 text-muted">
						{section.paras?.map((text) => <p key={text}>{text}</p>)}
						{section.table && (
							<div className="overflow-x-auto">
								<table className="w-full text-left text-sm">
									<thead>
										<tr className="border-b border-line text-foreground">
											{section.table.head.map((cell) => (
												<th key={cell} className="py-2 pr-4 font-medium">{cell}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{section.table.rows.map((row) => (
											<tr key={row[0]} className="border-b border-line align-top">
												{row.map((cell) => <td key={cell} className="py-2 pr-4">{cell}</td>)}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{section.list && (
							<ul className="list-disc space-y-2 pl-5">
								{section.list.map((text) => <li key={text}>{text}</li>)}
							</ul>
						)}
					</div>
				</section>
			))}
		</main>
	);
}
