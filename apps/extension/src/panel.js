import { DEFAULT_API, defaultModel, plain, readSse } from './lib.js';

/**
 * The side panel: one conversation with Lain over the Lain OS API
 * (OpenAI-compatible, streamed). The key lives in chrome.storage.local and
 * goes to lain-os.com only; the last 30 messages are kept for the next open.
 */

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const modelSelect = $('model');
let messages = [];
let busy = false;

const settings = async () => chrome.storage.local.get({ apiKey: '', api: DEFAULT_API, model: null, history: [] });

function render() {
    log.replaceChildren();
    if (messages.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Ask Lain anything, or select text on a page → right click → Ask Lain.';
        log.append(empty);
    }
    for (const message of messages) {
        const div = document.createElement('div');
        div.className = `msg ${message.role === 'user' ? 'user' : 'lain'}${message.error ? ' error' : ''}`;
        div.textContent = plain(message.content);
        log.append(div);
    }
    log.scrollTop = log.scrollHeight;
}

async function loadModels() {
    const { apiKey, api, model } = await settings();
    modelSelect.replaceChildren();
    if (!apiKey) {
        $('settings').hidden = false;
        return;
    }
    try {
        const response = await fetch(`${api}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const list = (await response.json()).data ?? [];
        for (const m of list) {
            const option = document.createElement('option');
            option.value = m.id;
            option.textContent = `${m.lain_agent ? '✦ ' : ''}${m.name ?? m.id}`;
            modelSelect.append(option);
        }
        modelSelect.value = list.some((m) => m.id === model) ? model : defaultModel(list) ?? '';
    } catch (error) {
        messages.push({ role: 'assistant', content: `Could not read the models (${error.message}). Check the API key in settings.`, error: true });
        render();
    }
}

async function send(text) {
    const { apiKey, api } = await settings();
    if (!apiKey) {
        $('settings').hidden = false;
        return;
    }
    busy = true;
    messages.push({ role: 'user', content: text });
    const answer = { role: 'assistant', content: '' };
    messages.push(answer);
    render();
    try {
        const response = await fetch(`${api}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelSelect.value,
                stream: true,
                messages: messages.filter((m) => !m.error && m !== answer).map(({ role, content }) => ({ role, content })),
            }),
        });
        if (!response.ok || !response.body) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail?.error?.message ?? `HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const read = readSse(buffer + decoder.decode(value, { stream: true }));
            buffer = read.rest;
            answer.content += read.text;
            render();
        }
    } catch (error) {
        answer.content = `Lain could not answer: ${error.message}`;
        answer.error = true;
    } finally {
        busy = false;
        render();
        await chrome.storage.local.set({ history: messages.slice(-30) });
    }
}

$('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    void send(text);
});
input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('form').requestSubmit();
    }
});
$('settings-toggle').addEventListener('click', () => {
    $('settings').hidden = !$('settings').hidden;
});
$('clear').addEventListener('click', async () => {
    messages = [];
    render();
    await chrome.storage.local.set({ history: [] });
});
$('save').addEventListener('click', async () => {
    await chrome.storage.local.set({ apiKey: $('key').value.trim() });
    $('settings').hidden = true;
    await loadModels();
});
modelSelect.addEventListener('change', () => chrome.storage.local.set({ model: modelSelect.value }));

/** A prompt a menu item left: typed in, never sent by itself. */
async function takePending() {
    const { pending } = await chrome.storage.session.get('pending');
    if (pending?.prompt && Date.now() - pending.at < 60_000) {
        input.value = pending.prompt;
        input.focus();
        await chrome.storage.session.remove('pending');
    }
}
chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pending?.newValue) void takePending();
});

const initial = await settings();
$('key').value = initial.apiKey;
messages = initial.history ?? [];
render();
await loadModels();
await takePending();
