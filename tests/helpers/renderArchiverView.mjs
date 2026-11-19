// Renders ArchiverStatusView to static HTML for a batch of prop sets. It runs in its own
// process because the suite starts with --conditions react-server, which hides react-dom/server.
// Input: a JSON object {name: props}. Output: a JSON object {name: html}.
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ArchiverStatusView from "../../src/app/admin/components/ArchiverStatusView.jsx";

const cases = JSON.parse(process.argv[2]);
const html = Object.fromEntries(
	Object.entries(cases).map(([name, props]) => [name, renderToStaticMarkup(createElement(ArchiverStatusView, props))]),
);

process.stdout.write(JSON.stringify(html));
