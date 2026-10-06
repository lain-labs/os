#!/usr/bin/env -S npx tsx
/**
 * Telegram formatting smoke test: the model's Markdown arrives formatted, not
 * as asterisks; the reply stamp names the model once.
 *
 * Run: npm run telegram:smoke
 */
import { markdownToTelegramHtml } from "../src/clients/telegram-format.js";
import { htmlToText } from "../src/plugins/telegram/index.js";
import { answerStamp } from "../src/models/routing.js";
import { TaskKind } from "../src/models/tasks.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const md = markdownToTelegramHtml;

check("**bold** becomes <b>", md("**w4** now watches") === "<b>w4</b> now watches");
check("`code` becomes <code> and is not formatted inside", md("`0x7d3a…c841` **x**") === "<code>0x7d3a…c841</code> <b>x</b>");
check("bullets become •", md("- **#96** is back") === "• <b>#96</b> is back");
check("markup in text is escaped", md("a < b & c > d") === "a &lt; b &amp; c &gt; d");
check("html in code is escaped", md("`<b>`") === "<code>&lt;b&gt;</code>");
check(
  "links keep their url",
  md("[0xbe0b…c8d9](https://robinhoodchain.blockscout.com/address/0xbe0b)") ===
    '<a href="https://robinhoodchain.blockscout.com/address/0xbe0b">0xbe0b…c8d9</a>',
);
check("headings become bold", md("## что сделано") === "<b>что сделано</b>");
check("fenced code becomes <pre>", md("```js\nconst a = 1 < 2;\n```") === "<pre>const a = 1 &lt; 2;</pre>");
const table = md("| ключ | значение |\n|---|---|\n| `CHAIN_ID` | **4663** |");
check("tables become aligned monospace", table.startsWith("<pre>") && table.includes("CHAIN_ID  4663") && !table.includes("|"));
check("single * and snake_case stay as they are", md("5 * 3 and my_var_name") === "5 * 3 and my_var_name");
check("quotes become blockquote", md("> note") === "<blockquote>note</blockquote>");
check("the HTML fallback reads back as text", htmlToText(md("**a** & [b](https://x.y)")) === "a & b (https://x.y)");

check(
  "a CLI model is named once",
  answerStamp({ provider: "claude", model: "claude/claude-opus-5-5", task: TaskKind.CHAT }).endsWith("· claude/claude-opus-5-5"),
);
check(
  "an API model still gets its provider",
  answerStamp({ provider: "openrouter", model: "openai/gpt-oss-120b" }) === "openrouter/openai/gpt-oss-120b",
);

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} telegram check(s) failed`);
  process.exit(1);
}
console.log(`telegram smoke ok (${results.length} checks)`);
