//default layout

import { Geist } from "next/font/google";
import MotionProvider from "./components/MotionProvider";
import DevDiagnostics from "./components/perf/DevDiagnostics";
import "./globals.css";

// latin-ext carries the Polish letters (ą ć ę ł ń ś ź ż); without it they fall back to a system font.
const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin", "latin-ext"],
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
		<html lang="pl" data-scroll-behavior="smooth">
			<body className={geistSans.variable}>
				<DevDiagnostics />
				<MotionProvider>{children}</MotionProvider>
			</body>
		</html>
	);
}
