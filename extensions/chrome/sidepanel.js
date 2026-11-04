const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const input = $("input");
const notice = $("notice");
const defaults = { server: "http://127.0.0.1:7777", key: "" };
let settings = { ...defaults };
let conversation = { roomId: newRoom(), messages: [] };
let busy = false;

function newRoom() { return `chrome-${crypto.randomUUID()}`; }
function render() {
  messagesEl.replaceChildren();
  if (!conversation.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const symbol = document.createElement("b");
    symbol.textContent = "✳";
    empty.append(symbol, "Lain is here. Start a conversation, or add a selection from the page you are reading.");
    messagesEl.append(empty);
    return;
  }
  for (const message of conversation.messages) {
    const item = document.createElement("article");
    item.className = `message ${message.role}`;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = message.role === "user" ? "You" : "Lain";
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = message.text;
    item.append(role, text);
    messagesEl.append(item);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function setBusy(value) {
  busy = value;
  $("send").disabled = value;
  $("new-chat").disabled = value;
  $("save-settings").disabled = value;
  $("send").textContent = value ? "Thinking…" : "Send ↗";
}
async function saveConversation() {
  await chrome.storage.local.set({ conversation });
}
function localServer(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use a local HTTP origin, such as http://127.0.0.1:7777.");
  }
  return url.origin;
}
$("open-web").addEventListener("click", async () => {
  try { await chrome.tabs.create({ url: "https://chat.lain-os.com/" }); }
  catch { notice.textContent = "Could not open Lain OS in a new tab."; }
});
$("settings-toggle").addEventListener("click", () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
});
$("save-settings").addEventListener("click", async () => {
  try {
    const next = { server: localServer($("server").value.trim()), key: $("key").value.trim() };
    await chrome.storage.local.set({ settings: next });
    settings = next;
    $("settings-message").textContent = "Connection saved.";
  } catch (error) { $("settings-message").textContent = error.message || "Could not save settings."; }
});
$("new-chat").addEventListener("click", async () => {
  if (busy) return;
  conversation = { roomId: newRoom(), messages: [] };
  notice.textContent = "";
  render();
  try { await saveConversation(); } catch { notice.textContent = "Could not save the new conversation."; }
});
$("attach").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active page found.");
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title, url: location.href, selection: window.getSelection()?.toString() || "" }) });
    if (!result.selection.trim()) throw new Error("Select some text on the page first.");
    const excerpt = result.selection.slice(0, 12000);
    input.value += `${input.value.trim() ? "\n\n" : ""}Page: ${result.title}\n${result.url}\n\nSelected text:\n${excerpt}`;
    notice.textContent = result.selection.length > excerpt.length ? "Selection was limited to 12,000 characters." : "Selection added to your draft.";
    input.focus();
  } catch (error) { notice.textContent = error.message || "Cannot read this page. Try a regular web page."; }
});
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (busy || !text) return;
  setBusy(true);
  notice.textContent = "";
  try {
    const response = await fetch(`${settings.server}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(settings.key ? { Authorization: `Bearer ${settings.key}` } : {}) },
      body: JSON.stringify({ roomId: conversation.roomId, userId: settings.key ? "user" : "chrome:local", text }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    conversation.messages.push({ role: "user", text }, { role: "assistant", text: typeof result.text === "string" ? result.text : "(No text returned.)" });
    if (input.value.trim() === text) input.value = "";
    render();
    try { await saveConversation(); } catch { notice.textContent = "Reply received, but the conversation could not be saved in Chrome."; }
  } catch (error) {
    notice.textContent = `Could not reach Lain: ${error.message || "connection failed"}. Check the daemon and allowed extension origin in settings.`;
  } finally { setBusy(false); }
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
async function init() {
  setBusy(true);
  $("origin").textContent = `chrome-extension://${chrome.runtime.id}`;
  try {
    const stored = await chrome.storage.local.get(["settings", "conversation"]);
    if (stored.settings) {
      try { settings = { server: localServer(stored.settings.server), key: typeof stored.settings.key === "string" ? stored.settings.key : "" }; } catch { /* use defaults */ }
    }
    if (typeof stored.conversation?.roomId === "string" && Array.isArray(stored.conversation.messages)) {
      conversation = { roomId: stored.conversation.roomId, messages: stored.conversation.messages.filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.text === "string") };
    }
    $("server").value = settings.server;
    $("key").value = settings.key;
    render();
  } catch { notice.textContent = "Could not load saved settings or conversation."; render(); }
  finally { setBusy(false); }
}
void init();
