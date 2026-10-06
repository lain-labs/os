/**
 * The model writes Markdown; Telegram renders either its own HTML subset or
 * nothing at all. Sent as plain text, a reply arrived studded with `**` and
 * backticks. This turns the Markdown a model actually produces into Telegram
 * HTML (parse_mode=HTML):
 *
 *   **bold** / __bold__  → <b>        `code`        → <code>
 *   ~~strike~~           → <s>        ```fenced```  → <pre>
 *   [text](url)          → <a href>   # heading     → <b>heading</b>
 *   - item / * item      → • item     > quote       → <blockquote>
 *   | a | b | tables     → an aligned <pre> block (Telegram has no tables)
 *
 * Single `*` / `_` italics are left alone on purpose: in chat they are far
 * more often a multiplication sign or a snake_case name than emphasis.
 * Everything else is escaped, so stray `<`, `>` and `&` stay text.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline Markdown on one line of already-split text. Code spans are protected first. */
function inline(line: string): string {
  const codes: string[] = [];
  let s = line.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
    links.push(`<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(text)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = escapeHtml(s)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?=[^\w]|$)/g, "$1<b>$2</b>")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<s>$1</s>");
  return s
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Visible width of a cell once its Markdown is stripped. */
function plainCell(cell: string): string {
  return cell
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}

function isTableRule(line: string): boolean {
  return /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line);
}

/** A Markdown table as monospace columns — the only way it lines up in Telegram. */
function table(rows: string[]): string {
  const cells = rows
    .filter((r) => !isTableRule(r))
    .map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(plainCell),
    );
  const cols = Math.max(...cells.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, c) => Math.min(28, Math.max(...cells.map((r) => (r[c] ?? "").length))));
  const lines = cells.map((r) =>
    width
      .map((w, c) => {
        const v = r[c] ?? "";
        return (v.length > w ? `${v.slice(0, w - 1)}…` : v).padEnd(w);
      })
      .join("  ")
      .trimEnd(),
  );
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && (isTableRow(lines[i]) || isTableRule(lines[i]))) rows.push(lines[i++]);
      i--;
      out.push(table(rows));
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(inline(lines[i++].replace(/^\s*>\s?/, "")));
      i--;
      out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────────");
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2])}`);
      continue;
    }

    out.push(inline(line));
  }
  return out.join("\n");
}
