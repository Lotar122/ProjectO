//default layout

import { Geist, Geist_Mono } from "next/font/google";
import ScrollPerfDiagnostics from "./components/perf/ScrollPerfDiagnostics";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata = {
	title: "ProjectO",
	description: "System do zarządzania zleceniami ortodontycznymi.",
};

export const viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: "#0B101C",
	colorScheme: "dark",
};

export default function RootLayout({ children })
{
	return (
		<html lang="pl">
			<body className={`${geistSans.variable} ${geistMono.variable}`}>
				<ScrollPerfDiagnostics />
				{children}
			</body>
		</html>
	);
}
