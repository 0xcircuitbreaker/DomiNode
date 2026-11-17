/**
 * Minimal, dependency-free HTML to markdown / plain-text converter for dominusnode_fetch.
 *
 * Design constraints:
 * - Deterministic: same input, same output; no DOM, no network, no clock.
 * - Bounded in time: a single forward scan with indexOf (no backtracking regexes over
 *   the document), so cost is linear in the input length. Input is already capped at
 *   10MB by the fetch layer; MAX_INPUT_CHARS is a second cap.
 * - Drops non-content elements entirely: script, style, noscript, template, svg, math,
 *   head, iframe, object, canvas, and HTML comments.
 * - Never emits raw HTML. Links are kept only for http(s), mailto and relative targets
 *   (javascript:/data:/vbscript: are dropped, text is kept).
 */

export type HtmlOutputFormat = "markdown" | "text";

export const MAX_INPUT_CHARS = 12 * 1024 * 1024;

const SKIP_CONTENT = new Set([
  "script", "style", "noscript", "template", "svg", "math", "head", "iframe", "object", "canvas", "select",
]);

const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset",
  "table", "thead", "tbody", "tfoot", "ul", "ol", "dl", "dd", "dt", "figure", "figcaption",
  "address", "details", "summary", "body", "html",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®",
  trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•",
  euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", times: "×",
};

/** Decode HTML entities (named subset + numeric). Unknown entities are left as-is. */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v ?? m;
  });
}

/** Parse attributes from the inside of a start tag (after the tag name). Linear scan. */
function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(s[i])) i++;
    const start = i;
    while (i < n && !/[\s=/>]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < n && /\s/.test(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < n && /\s/.test(s[i])) i++;
      const q = s[i];
      if (q === "\"" || q === "'") {
        const end = s.indexOf(q, i + 1);
        const stop = end === -1 ? n : end;
        value = s.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < n && !/[\s>]/.test(s[i])) i++;
        value = s.slice(vs, i);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /[\s<>()]/.test(h) || h.length > 2048) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(h);
  if (scheme && !["http", "https", "mailto"].includes(scheme[1].toLowerCase())) return null;
  return h;
}

/** Markdown-escape characters that would otherwise be read as formatting at line start or inline. */
function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]])/g, "\\$1");
}

interface Ctx {
  md: boolean;
  out: string[];
  pre: number;
  listStack: Array<{ ordered: boolean; n: number }>;
  linkStack: Array<string | null>;
}

function push(ctx: Ctx, s: string): void {
  ctx.out.push(s);
}

function blockBreak(ctx: Ctx): void {
  push(ctx, "\n\n");
}

function handleText(ctx: Ctx, raw: string): void {
  if (!raw) return;
  let t = decodeEntities(raw);
  if (ctx.pre > 0) {
    push(ctx, t);
    return;
  }
  t = t.replace(/[\t\n\r\f ]+/g, " ");
  if (ctx.md) t = escapeMd(t);
  push(ctx, t);
}

function handleTag(ctx: Ctx, name: string, closing: boolean, attrs: Record<string, string>): void {
  const md = ctx.md;
  if (/^h[1-6]$/.test(name)) {
    blockBreak(ctx);
    if (!closing && md) push(ctx, "#".repeat(Number(name[1])) + " ");
    return;
  }
  switch (name) {
    case "br":
      push(ctx, "\n");
      return;
    case "hr":
      blockBreak(ctx);
      if (md) push(ctx, "---");
      blockBreak(ctx);
      return;
    case "ul":
    case "ol":
      if (closing) ctx.listStack.pop();
      else ctx.listStack.push({ ordered: name === "ol", n: 0 });
      blockBreak(ctx);
      return;
    case "li": {
      if (closing) return;
      const top = ctx.listStack[ctx.listStack.length - 1];
      const depth = Math.max(0, ctx.listStack.length - 1);
      push(ctx, "\n" + "  ".repeat(Math.min(depth, 8)));
      if (top?.ordered) push(ctx, `${++top.n}. `);
      else push(ctx, md ? "- " : "* ");
      return;
    }
    case "tr":
      push(ctx, "\n");
      return;
    case "td":
    case "th":
      if (!closing) push(ctx, md ? " | " : "\t");
      return;
    case "blockquote":
      blockBreak(ctx);
      if (!closing && md) push(ctx, "> ");
      return;
    case "pre":
      if (closing) {
        ctx.pre = Math.max(0, ctx.pre - 1);
        if (md) push(ctx, "\n```");
        blockBreak(ctx);
      } else {
        blockBreak(ctx);
        ctx.pre++;
        if (md) push(ctx, "```\n");
      }
      return;
    case "code":
      if (md && ctx.pre === 0) push(ctx, "`");
      return;
    case "strong":
    case "b":
      if (md) push(ctx, "**");
      return;
    case "em":
    case "i":
      if (md) push(ctx, "_");
      return;
    case "a":
      if (!md) return;
      if (!closing) {
        const href = safeHref(attrs.href);
        ctx.linkStack.push(href);
        if (href) push(ctx, "[");
      } else if (ctx.linkStack.length) {
        const href = ctx.linkStack.pop();
        if (href) push(ctx, `](${href})`);
      }
      return;
    case "img": {
      const alt = (attrs.alt ?? "").replace(/[\s]+/g, " ").trim();
      if (!alt) return;
      push(ctx, md ? `![${escapeMd(alt)}]` : alt);
      return;
    }
    case "title":
      return;
    default:
      if (BLOCK.has(name)) blockBreak(ctx);
  }
}

function tidy(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

/** Convert an HTML document to markdown (default) or plain text. */
export function htmlToMarkdown(html: string, format: HtmlOutputFormat = "markdown"): string {
  const src = html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html;
  const ctx: Ctx = { md: format === "markdown", out: [], pre: 0, listStack: [], linkStack: [] };
  const n = src.length;
  let i = 0;
  // Keep only the first <title> as a heading-ish prefix.
  let title = "";

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      handleText(ctx, src.slice(i));
      break;
    }
    if (lt > i) handleText(ctx, src.slice(i, lt));

    // Comment
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Doctype / processing instruction / CDATA
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const closing = src[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    let j = nameStart;
    while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
    const name = src.slice(nameStart, j).toLowerCase();
    if (!name || !/^[a-z]/.test(name)) {
      // Not a tag: literal "<".
      handleText(ctx, "<");
      i = lt + 1;
      continue;
    }
    const gt = findTagEnd(src, j);
    const attrText = src.slice(j, gt === -1 ? n : gt);
    i = gt === -1 ? n : gt + 1;

    if (!closing && (SKIP_CONTENT.has(name) || name === "title")) {
      if (/\/\s*$/.test(attrText)) continue; // self-closing
      const closeIdx = indexOfCloseTag(src, name, i);
      if (name === "title" && !title) title = cleanTitle(src.slice(i, closeIdx === -1 ? n : closeIdx));
      if (name === "head" && !title) title = titleFromHead(src.slice(i, closeIdx === -1 ? n : closeIdx));
      if (closeIdx === -1) { i = n; continue; }
      const closeGt = src.indexOf(">", closeIdx);
      i = closeGt === -1 ? n : closeGt + 1;
      continue;
    }
    if (closing && SKIP_CONTENT.has(name)) continue;

    handleTag(ctx, name, closing, closing ? {} : parseAttrs(attrText));
  }

  let body = tidy(ctx.out.join(""));
  if (title && ctx.md && !body.startsWith("# ")) body = `# ${escapeMd(title.slice(0, 500))}\n\n${body}`;
  else if (title && !ctx.md && !body.startsWith(title)) body = `${title.slice(0, 500)}\n\n${body}`;
  return body;
}

function cleanTitle(raw: string): string {
  return decodeEntities(raw.slice(0, 4096)).replace(/\s+/g, " ").trim();
}

/** First <title> inside a skipped <head>. Linear. */
function titleFromHead(head: string): string {
  const lower = head.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return "";
  const gt = head.indexOf(">", open);
  if (gt === -1) return "";
  const close = lower.indexOf("</title", gt);
  return cleanTitle(head.slice(gt + 1, close === -1 ? head.length : close));
}

/** Index of the '>' ending a tag, skipping quoted attribute values. -1 if unterminated. */
function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === "\"" || c === "'") {
      q = c;
    } else if (c === ">") {
      return k;
    }
  }
  return -1;
}

/** Case-insensitive search for `</name` starting at `from`. Linear. */
function indexOfCloseTag(s: string, name: string, from: number): number {
  const needle = "</" + name;
  const lower = needle.length;
  let k = from;
  for (;;) {
    const idx = s.indexOf("</", k);
    if (idx === -1) return -1;
    if (s.slice(idx, idx + lower).toLowerCase() === needle) {
      const after = s[idx + lower];
      if (after === undefined || /[\s>/]/.test(after)) return idx;
    }
    k = idx + 2;
  }
}

/** True for content types this converter applies to. */
export function isHtmlContentType(contentType: string | undefined): boolean {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ct === "text/html" || ct === "application/xhtml+xml";
}
