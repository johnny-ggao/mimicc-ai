import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { NEVER_REPLAY } from "./replay";
import { neutralizeControlTags } from "./untrusted";

/**
 * Fetch one URL and hand the model its readable text (web-tools ticket 02).
 *
 * Three mechanisms live here, and they are the reason the ticket exists:
 *
 * - **Externalise, do not truncate.** A page over {@link EXTERNALIZE_MIN_CHARS}
 *   is written to disk in full; the model sees a deterministic synopsis — title,
 *   size, heading outline, a preview — plus the path, and Reads the file when it
 *   wants the rest. Copied from deer-flow's tool-output budget middleware as a
 *   mechanism (theirs hangs on LangChain hooks; here it is a function call in
 *   the one tool that needs it). The in-tool `[:4096]` truncation deer-flow
 *   *also* still carries predates that mechanism and is deliberately not copied.
 * - **SSRF floor.** Every hop — the URL and each redirect — has its hostname
 *   resolved and every address checked against the private/reserved ranges
 *   before a request is made. Same shape as deer-flow's `url_safety.py`. The
 *   check is resolve-then-fetch, so a DNS answer that changes between the two
 *   (rebinding) slips it; closing that needs pinning the connection to the
 *   checked address, which this does not do. Accepted and written down rather
 *   than implied away.
 * - **Neutralise control-shaped text** in what comes back — see
 *   `tools/untrusted.ts`. Applied last, after entity decoding, because decoding
 *   `&lt;` back into `<` after neutralising would undo it.
 *
 * ## Why the HTML extraction is hand-rolled
 *
 * The usual stack (readability + a DOM + turndown) is three dependencies in a
 * repository that ships five. What this needs from them today — drop the
 * scripts and chrome, keep headings, paragraphs, lists and links, as markdown —
 * is a page of regex with known edge cases (nested same-name tags confuse the
 * paired-tag removal; regex over HTML is approximate by nature). The seam to
 * upgrade behind is {@link extractReadable}: one function, text in, text out.
 * If the acceptance probes (research-kind ticket 03) show real pages coming
 * back as garbage, swapping its body for readability is a one-file change.
 */

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
/** Download cap in bytes. Past it the read stops and the result says so. */
const MAX_FETCH_BYTES = 5_000_000;

/** Past this many characters the text goes to disk and the model gets a synopsis. */
export const EXTERNALIZE_MIN_CHARS = 12_000;
/** How much of the text the synopsis shows verbatim. */
const PREVIEW_CHARS = 2_000;
/** Head/tail clip used only when writing the file failed. */
const FALLBACK_HEAD_CHARS = 8_000;
const FALLBACK_TAIL_CHARS = 2_000;

/** Where externalised pages land. Stable across processes so a resumed session's paths still Read. */
const STORE_DIR = join(tmpdir(), "mimicc-web");

/* ---------- SSRF floor ---------- */

/** Whether an IPv4 address (as dotted quad) is private, loopback, link-local or otherwise not the public internet. */
function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 special
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Same question for IPv6, including the v4-mapped form. */
function isPrivateV6(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1]);
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (old site-local)
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^fe[cdef]/.test(ip);
}

/**
 * Refuses a hostname whose addresses include any non-public one.
 *
 * *Any*, not *all*: a name that resolves to one public and one private address
 * is exactly the shape an SSRF attempt takes, so mixed resolution refuses too.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const refusal = (what: string) =>
    new Error(
      `refusing to fetch ${hostname}: ${what}. WebFetch only reaches the public internet — private and internal addresses are off limits.`,
    );

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw refusal("it is localhost");
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (caught) {
    throw new Error(
      `cannot resolve ${hostname}: ${caught instanceof Error ? caught.message : String(caught)}`,
      { cause: caught },
    );
  }
  if (addresses.length === 0) throw refusal("it resolves to no address");
  for (const { address, family } of addresses) {
    const isPrivate = family === 6 ? isPrivateV6(address) : isPrivateV4(address);
    if (isPrivate) throw refusal(`it resolves to ${address}`);
  }
}

/* ---------- fetching ---------- */

/** Follows redirects by hand so every hop passes the SSRF floor. */
async function fetchPublic(
  rawUrl: string,
  allowPrivateHosts: boolean,
): Promise<{ response: Response; finalUrl: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`refusing ${url.protocol}// — WebFetch speaks http(s) only`);
    }
    if (!allowPrivateHosts) await assertPublicHost(url.hostname);

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A bare-bones UA: some sites refuse requests with none at all.
        "user-agent": "mimicc/0.1 (+cli coding agent)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) {
        throw new Error(`HTTP ${String(response.status)} with no Location header`);
      }
      url = new URL(location, url);
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error(`too many redirects (more than ${String(MAX_REDIRECTS)})`);
}

/** Reads at most {@link MAX_FETCH_BYTES}; says so when it stopped early. */
async function readCapped(
  response: Response,
): Promise<{ text: string; clipped: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", clipped: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let clipped = false;
  for (;;) {
    // Bun's stream types hand the chunk back as `any`; it is a Uint8Array at
    // runtime. One quarantined assertion, same move as the `metadata` reads in
    // tools/replay.ts.
    const { done, value } = (await reader.read()) as
      | { done: false; value: Uint8Array<ArrayBuffer> }
      | { done: true; value?: undefined };
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_FETCH_BYTES)));
      clipped = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  // Non-UTF-8 charsets decode lossily here. The replacement characters are
  // visible in the result, which is the honest failure — silently transcoding
  // is a bigger machine than this needs.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
  return { text, clipped };
}

/* ---------- HTML → readable markdown ---------- */

/** Decodes the entities that actually occur in prose. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&"); // last, or double-encoded text over-decodes
}

/** Removes `<tag …>…</tag>` blocks. Non-greedy, so nested same-name tags leave a tail — accepted, see header. */
function dropBlocks(html: string, tags: string): string {
  return html.replace(
    new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"),
    "",
  );
}

/** The first `<tag>…</tag>` region, when the page has one. */
function region(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, "i").exec(
    html,
  );
  return match?.[1];
}

/**
 * The extraction seam: HTML in, readable markdown-ish text out.
 *
 * Approximate by construction (regex over HTML) and deliberately so — see the
 * file header for the trade and the upgrade path.
 */
export function extractReadable(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title =
    titleMatch?.[1] === undefined
      ? undefined
      : decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim();

  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|template|svg|iframe|canvas|object|embed)\b[\s\S]*?<\/\1\s*>/gi,
      "",
    );

  // Prefer the page's own idea of its content, when it states one.
  s = region(s, "article") ?? region(s, "main") ?? region(s, "body") ?? s;
  s = dropBlocks(s, "nav|header|footer|aside|form|dialog");

  s = s
    .replace(
      /<h([1-6])[^>]*>/gi,
      (_, level: string) => `\n\n${"#".repeat(Number(level))} `,
    )
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<\/?pre[^>]*>/gi, "\n```\n")
    .replace(/<\/?code[^>]*>/gi, "`")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, href: string, inner: string) =>
        href.startsWith("javascript:") || href.startsWith("#")
          ? inner
          : `[${inner}](${href})`,
    )
    // Openers of block elements become line breaks so words do not glue.
    .replace(
      /<(p|div|section|blockquote|table|tr|ul|ol|dl|dd|dt|figure|figcaption)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");

  const text = decodeEntities(s)
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { ...(title !== undefined && title !== "" ? { title } : {}), text };
}

/* ---------- externalisation ---------- */

/** A deterministic, code-built synopsis: structure and preview, no LLM. */
function synopsis(text: string, title: string | undefined, url: string): string {
  const headings = text
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .slice(0, 12);
  return [
    ...(title === undefined ? [] : [`# ${title}`]),
    `URL: ${url}`,
    `Length: ${String(text.length)} chars`,
    ...(headings.length > 0 ? ["", "Outline:", ...headings.map((h) => `  ${h}`)] : []),
    "",
    `--- preview (first ${String(PREVIEW_CHARS)} chars) ---`,
    text.slice(0, PREVIEW_CHARS),
  ].join("\n");
}

/**
 * Puts an oversized page on disk and returns what the model sees instead.
 * When the write fails, degrades to a head/tail clip — and says which happened.
 */
function externalize(text: string, title: string | undefined, url: string): string {
  const host = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const hash = new Bun.CryptoHasher("sha256")
    .update(url)
    .update(text)
    .digest("hex")
    .slice(0, 12);
  const path = join(STORE_DIR, `${host}-${hash}.md`);

  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(path, `URL: ${url}\n\n${text}`);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return (
      `${text.slice(0, FALLBACK_HEAD_CHARS)}\n\n[...]\n\n${text.slice(-FALLBACK_TAIL_CHARS)}\n\n` +
      `[clipped: first ${String(FALLBACK_HEAD_CHARS)} and last ${String(FALLBACK_TAIL_CHARS)} of ` +
      `${String(text.length)} chars — saving the full text failed: ${reason}]`
    );
  }

  return (
    `${synopsis(text, title, url)}\n\n` +
    `[externalized: this is a synopsis, not the page. The full text (${String(text.length)} chars) ` +
    `is at ${path} — Read it for the rest.]`
  );
}

/* ---------- the tool ---------- */

export const WEB_FETCH_TOOL_NAME = "WebFetch";

/** Content types the tool will hand to the model as text. */
function isTextual(contentType: string): boolean {
  return (
    contentType === "" || // absent: assume text, the decoder shows the truth
    contentType.startsWith("text/") ||
    contentType.includes("html") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

/**
 * The tool's whole body, reachable without the tool.
 *
 * `allowPrivateHosts` exists for tests only — the pipeline past the SSRF floor
 * (redirects, extraction, externalisation, content types) can only be exercised
 * against a local stub, and a local stub is exactly what the floor refuses.
 * The tool below never passes it, so the shipped path always carries the floor.
 * Same precedent as `WindowTuning` on `AgentEnvironment`: a test-only reach
 * into otherwise-fixed behaviour, named as such.
 */
export async function webFetch(
  url: string,
  options?: { allowPrivateHosts?: boolean },
): Promise<string> {
  const { response, finalUrl } = await fetchPublic(
    url,
    options?.allowPrivateHosts ?? false,
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(
      `HTTP ${String(response.status)} fetching ${finalUrl.href}${body === "" ? "" : ` — ${body}`}`,
    );
  }

  const contentType =
    (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ??
    "";
  if (!isTextual(contentType)) {
    await response.body?.cancel();
    throw new Error(
      `cannot read ${finalUrl.href}: it is ${contentType}, and WebFetch returns text. ` +
        `There is no tool here that can parse it; say you cannot read it rather than guessing at its contents.`,
    );
  }

  const { text: raw, clipped } = await readCapped(response);
  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
  const { title, text } = isHtml ? extractReadable(raw) : { text: raw.trim() };

  if (text === "") return `the page at ${finalUrl.href} has no readable text`;

  const body =
    text.length > EXTERNALIZE_MIN_CHARS
      ? externalize(text, title, finalUrl.href)
      : title === undefined
        ? text
        : `# ${title}\n\n${text}`;

  const clipNote = clipped
    ? `\n[download stopped at ${String(MAX_FETCH_BYTES)} bytes; the page is larger]`
    : "";
  // Last, after entity decoding — see the header note on ordering.
  return neutralizeControlTags(body + clipNote);
}

export const webFetchTool = tool(async ({ url }): Promise<string> => webFetch(url), {
  name: WEB_FETCH_TOOL_NAME,
  // A GET of an arbitrary URL is not guaranteed effect-free — somebody's
  // /logout is a GET. The conservative declaration costs one synthetic
  // "interrupted" after a crash; the other direction re-fires the request.
  metadata: { ...NEVER_REPLAY },
  description: `Fetch a public web page and return its readable text as markdown. Follows redirects; refuses private and internal addresses. A page over ${String(EXTERNALIZE_MIN_CHARS)} chars is saved to a file and returned as a synopsis with the file path — Read that path for the full text. Only textual content; it cannot parse PDFs or images.`,
  schema: z.object({
    url: z.string().min(1).describe("The http(s) URL to fetch"),
  }),
});
