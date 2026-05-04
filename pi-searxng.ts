#!/usr/bin/env -S node --import ts-node/register/esm --experimental-specifier-resolution=node

/**
 * pi-searxng — Pi agent extension for private web search via SearXNG.
 * Uses the /search?format=json GET endpoint (structured JSON).
 *
 * USAGE EXAMPLES:
 *   searxng_web_search(query="Rust lifetimes explained", cats="it", num_results=5)
 *   searxng_web_search(query="best pasta recipe", cats="general")
 *   searxng_web_search(query="React hooks API", eng="wikipedia,stackoverflow", language="en")
 *   searxng_web_search(query="cute kittens", cats="images")
 *   searxng_web_search(query="stock price today", time_range="day")
 *   searxng_web_search(query="linux tutorial", time_range="week")
 *   searxng_web_search(query="who won fifa world cup", cats="news")
 *
 * CONFIGURATION:
 *   Place ~/.pi/searxng.json with a "baseUrl" field pointing to your SearXNG
 *   instance. Example: {"baseUrl": "http://localhost:80"}
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config — layered lookup
//   1. SEARXNG_URL env var — injected by pi / systemd / docker
//   2. ~/.pi/searxng.json  — user-facing config file (REQUIRED)
//   Neither is guessed. If both are missing we surface a clear error.
// ---------------------------------------------------------------------------

/** Resolve the config path ($HOME/.pi/searxng.json). */
function configFile(): string {
	return homedir() + "/.pi/searxng.json";
}

/**
 * Parse config, return { baseUrl } or undefined on any failure.
 * Caller must handle the undefined case.
 */
function loadConfig() {
	const cfgFile = configFile();
	try {
		const raw = readFileSync(cfgFile, "utf-8");
		const cfg = JSON.parse(raw);
		if (cfg.baseUrl && typeof cfg.baseUrl === "string") {
			return { baseUrl: cfg.baseUrl };
		}
	} catch {
		// Config file unreadable / invalid — silently fall through
	}
	return undefined;
}

/** Lazy singleton — first successful resolution wins. */
let cachedBaseUrl: string | undefined;

/**
 * Resolve the base URL. Throws if neither env var nor config file is set.
 */
function getBaseUrl(): string {
	if (cachedBaseUrl) return cachedBaseUrl;

	const envUrl = process.env.SEARXNG_URL;
	const conf = loadConfig();

	const url = envUrl ?? conf?.baseUrl;
	if (!url) {
		throw new Error(
			"SearXNG not configured. Place ~/.pi/searxng.json with a " +
				'"baseUrl" field, or set the SEARXNG_URL env var.',
		);
	}
	cachedBaseUrl = url;
	return cachedBaseUrl;
}

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Aliases map: whatever the LLM sends gets translated here
// ---------------------------------------------------------------------------
const ALIAS: Record<string, string> = {
	q: "query",
	query: "query",
	question: "query",
	qry: "query",
	cat: "cats",
	category: "cats",
	categories: "cats",
	cats: "cats",
	engine: "engines",
	engines: "engines",
	eng: "engines",
	nr: "num_results",
	"number of results": "num_results",
	max_results: "num_results",
	page_size: "num_results",
	num_results: "num_results",
	lang: "language",
	language: "language",
	loc: "language",
	pg: "pageno",
	page: "pageno",
	pageno: "pageno",
	tr: "time_range",
	time: "time_range",
	timerange: "time_range",
	ss: "safe_search",
	safe: "safe_search",
	of: "onion_version",
};

/** Normalize raw parameter object — maps every common alias to canonical names. */
function normalizeParams(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		const lk = k.toLowerCase();
		out[ALIAS[lk] ?? lk] = v;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Plugin entry-point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "searxng_web_search",
		label: "SearXNG Web Search",
		description:
			"Private, tracker-free web search via your local SearXNG instance. " +
			"No cookies, no fingerprinting, no Google profiling.",
		promptSnippet:
			"searxng_web_search(query: str, cats?: str, eng?: str, " +
			"num_results?: int, language?: str) — private web search",
		promptGuidelines: [
			"Always reach for searxng_web_search for factual, current, or " +
				"time-sensitive information.",
			`Technical/code/API -> cats="it", eng="stackoverflow,wikipedia".`,
			`Images/videos -> cats="images,videos".`,
			`Fresh info -> add time_range="day" or "week".`,
		],

		parameters: {
			type: "object" as const,
			required: ["query"],
			properties: {
				query: {
					type: "string" as const,
					description:
						'Search query. E.g. `"climate change causes"` or `"fastapi docs"`.',
				},
				cats: {
					type: "string" as const,
					description:
						"SearXNG category tabs: general, images, videos, news, it, science, " +
						"music, files, map. Comma-separate for multiple. Defaults to 'general'.",
				},
				eng: {
					type: "string" as const,
					description:
						"Narrow to specific engines: wikipedia, stackoverflow, reddit, " +
						"github, duckduckgo, brave. Comma-separate.",
				},
				num_results: {
					type: "number" as const,
					minimum: 1,
					maximum: 50,
					default: 8,
					description: "How many results to return. Must be ≤ 50. Default 8.",
				},
				language: {
					type: "string" as const,
					description: "Locale code ISO 639-1: en, de, fr, es, zh, ja, …",
				},
				pageno: {
					type: "number" as const,
					minimum: 1,
					default: 1,
					description: "Pagination offset.",
				},
				time_range: {
					type: "string" as const,
					enum: ["day", "week", "month", "year"],
					description: "Recency filter.",
				},
				safe_search: {
					type: "number" as const,
					enum: [0, 1, 2],
					description: "0=off, 1=moderate, 2=strict filtering.",
				},
				onion_version: {
					type: "boolean" as const,
					description: "Route through Tor (onion-enabled instances only).",
				},
			},
		},

		prepareArguments(raw) {
			return normalizeParams(raw);
		},

		/**
		 * Executes a SearXNG /search?format=json request and renders structured results.
		 * See: https://docs.searxng.org/dev/search_api.html
		 */
		async execute(_tid, raw, sig) {
			const p = normalizeParams(raw);

			/* ---------- sanity ------------------------------------------------- */
			const q = (p.query ?? "").toString().trim();
			if (!q) {
				return {
					content: [
						{
							type: "text",
							text: 'Supply a `query` parameter. E.g. `query="Rust lifetimes"`',
						},
					],
					isError: true,
				};
			}

			function pick<T>(key: string, fb: T): T {
				const v = p[key];
				if (v === undefined || v === null) return fb as T;
				if (typeof v === "string") return (v.length ? v : fb) as T;
				if (typeof v === "number") return v as unknown as T;
				return fb;
			}

			const cats = pick<string>("cats", "general");
			const numRes = clamp(Number(p.num_results ?? 8), 1, 50);
			const lang = p.language as string | undefined;
			const eng = p.eng as string | undefined;
			const pg = clamp(Math.round(Number(p.pageno ?? 1)), 1, Infinity);
			const _triRaw = (p.time_range as string) || "";
			const trValid: readonly string[] = ["day", "week", "month", "year"];
			const tr = trValid.includes(_triRaw)
				? (_triRaw as "day" | "week" | "month" | "year")
				: undefined;
			const _ssNum = Number(p.safe_search);
			const ss = [0, 1, 2].includes(_ssNum) ? _ssNum : undefined;
			const ov = Boolean(p.onion_version);

			/* ---------- build GET query-string for /search?format=json --------- */
			const qs: string[] = [
				`q=${encodeURIComponent(q)}`,
				`format=json`,
				`categories=${cats}`,
				`pageno=${pg}`,
			];
			if (eng) qs.push(`engines=${eng}`);
			if (lang) qs.push(`language=${lang}`);
			if (tr) qs.push(`time_range=${tr}`);
			if (ss != null) qs.push(`safe_search=${ss}`);
			if (ov) qs.push("onion_version=1");

			/* ---------- dispatch w/ timeout ----------------------------------- */
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
			sig?.addEventListener("abort", () => ac.abort(), { once: true });

			try {
				const r = await fetch(getBaseUrl() + "/search?" + qs.join("&"), {
					signal: ac.signal,
				});
				if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText);

				const data = (await r.json()) as {
					results: Array<{
						url: string;
						title: string;
						content?: string;
						engine?: string;
						category?: string;
						template?: string;
						img_src?: string;
						thumbnail?: string;
						pubdate?: string;
						views?: string;
						source?: string;
						duration?: string;
						length?: string;
						[a: string]: any;
					}>;
					suggestions?: string[];
					unresponsive_engines?: string[];
					corrections?: string[];
					answers?: any[];
					query?: string;
				};

				const hits = data.results.slice(0, numRes);

				/* --- no hits ------------------------------------------------- */
				if (!hits.length) {
					let txt = 'No results for "' + q + '"';
					if (data.suggestions?.length)
						txt += "\nSuggestions: " + data.suggestions.join(", ");
					if (data.unresponsive_engines?.length)
						txt += "\nBroken: " + data.unresponsive_engines.join(", ");
					if (data.corrections?.length)
						txt += "\nSpelling: " + data.corrections.join(", ");
					return { content: [{ type: "text", text: txt }], isError: true };
				}

				/* --- render ---------------------------------------------------- */
				const lines = hits.map((hit, ix) => {
					const n = ix + 1;
					const title = esc(hit.title || "?");
					const url = shortUrl(hit.url || "?");
					const badge = hit.engine ? "[" + hit.engine + "]" : "";

					const extra: string[] = [];
					if (hit.views) extra.push("👁 " + hit.views);
					if (hit.pubdate) extra.push("📅 " + hit.pubdate);
					if (hit.source) extra.push(hit.source);

					const meta = badge + extra.join("");

					let note = "";
					if (hit.template === "images.html" || hit.category === "images") {
						note = "[IMG] " + (hit.img_src ? "attached" : "no thumb");
					} else if (
						hit.category === "videos" ||
						hit.template === "videos.html"
					) {
						const dur = hit.duration || hit.length || "";
						if (dur) note = "@" + dur;
					} else if (hit.content) {
						const cleaned = stripHtml(hit.content).replace(/\s+/g, " ").trim();
						const trimmed =
							cleaned.length > 320 ? cleaned.substring(0, 320) + "…" : cleaned;
						if (trimmed) note = ">" + trimmed;
					}

					const rankTag = meta ? " *" + esc(md(meta)) + "*" : "";
					let buf = n + "." + rankTag + " _[" + title + "]_(" + url + ")_";
					if (note) buf += "\n  " + note;
					return buf;
				});

				const footer: string[] = [];
				if (data.suggestions?.length)
					footer.push("Tip: " + data.suggestions.join(", "));
				if (data.corrections?.length)
					footer.push("Correct: " + data.corrections.join(", "));
				if (data.unresponsive_engines?.length)
					footer.push("! Broken: " + data.unresponsive_engines.join(", "));

				return {
					content: [
						{
							type: "text",
							text:
								lines.join("\n\n") +
								(footer.length ? "\n\n" + footer.join("\n") : ""),
						},
					],
					details: {
						found: data.results.length,
						showing: hits.length,
						query: q,
						cats,
						eng: eng || "all",
						errors: data.unresponsive_engines,
						allUrls: hits.map((h) => h.url),
					},
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				const baseUrlStr = (() => {
					try {
						return getBaseUrl();
					} catch {
						return "[unknown]";
					}
				})();
				return {
					content: [
						{
							type: "text",
							text:
								"SearXNG unreachable: " +
								msg.substring(0, 200) +
								"\n\nCheck: `curl " +
								baseUrlStr +
								"/search?q=test`",
						},
					],
					isError: true,
				};
			} finally {
				clearTimeout(t);
			}
		},
	});
}

// ================================================================
// Helpers
// ================================================================

function esc(x: string): string {
	// Minimal: protect backslash and backtick so they don't wreck markdown.
	return x.replace(/\\/g, "\\\\").replace(/`/g, "`");
}

/** Escape Markdown inline specials. */
function md(s: string) {
	return s.replace(/[*_`]/g, "\\$&");
}

function shortUrl(raw: string): string {
	if (raw.length < 200) return raw;
	try {
		var u = new URL(raw);
		var segs = u.pathname.split("/").filter(Boolean);
		u.pathname = "/" + segs.slice(0, 3).join("/");
		return u.origin + u.pathname;
	} catch {
		return raw.substring(0, 150);
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return isNaN(n) ? lo : n < lo ? lo : n > hi ? hi : n;
}

function stripHtml(s: string): string {
	return s.replace(/<[^>]*>/g, "");
}
