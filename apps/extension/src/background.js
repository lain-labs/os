import { promptFor, MAX_PAGE_CHARS } from './lib.js';

/**
 * The menu items and the icon. A menu item never sends anything by itself: it
 * opens the side panel with the prompt typed in, and the person presses send.
 */

chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'ask', title: 'Ask Lain about "%s"', contexts: ['selection'] });
        chrome.contextMenus.create({ id: 'token', title: 'Research this token with Lain', contexts: ['selection'] });
        chrome.contextMenus.create({ id: 'page', title: 'Summarise this page with Lain', contexts: ['page'] });
    });
});

async function pageText(tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (limit) => (document.body?.innerText ?? '').slice(0, limit),
            args: [MAX_PAGE_CHARS],
        });
        return result?.result ?? '';
    } catch {
        // chrome:// pages and the Web Store cannot be read; the title still can.
        return '';
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    // Opening the panel must happen inside the click, before anything awaits.
    if (tab?.windowId !== undefined) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    }
    void (async () => {
        const kind = String(info.menuItemId);
        const text = kind === 'page' && tab?.id !== undefined ? await pageText(tab.id) : '';
        const prompt = promptFor(kind, { selection: info.selectionText ?? '', title: tab?.title ?? '', url: tab?.url ?? '', text });
        await chrome.storage.session.set({ pending: { prompt: prompt ?? 'That selection is not a token address (an 0x contract or a Solana mint).', at: Date.now() } });
    })();
});
