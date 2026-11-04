import type { PlanFile } from "./index.js";

/**
 * The plan of the review of 2026-11-04 (claude.ai/artifact/XmFYSG5pmXP2T56QFrqVdk),
 * written into data/plan.json on the first start. After that the file is the
 * plan: edit it there, or tick items off with the buttons.
 */
export const SEED_PLAN: PlanFile = {
  people: {
    lev: { name: "Лев", chatId: "819914001" },
    orpheus: { name: "Орфей", chatId: "1152962777" },
  },
  items: [
    { id: "fuji-avax", owner: "lev", title: "Пополнить валидатор Cyberia 2.0", due: "2026-11-06", status: "done", why: "без баланса на P-Chain сеть стоит", note: "0,953 AVAX — хватит до 26 ноября" },
    { id: "guard-mode", owner: "lev", title: "Поднять Guard Mode кошелька Лейн до $100 в сутки", due: "2026-11-07", status: "todo", why: "сейчас каждый своп Лейн ждёт письма — живых сделок нет" },
    { id: "gh-workflow", owner: "lev", title: "Дать токену gh право на workflow (gh auth refresh -s workflow)", due: "2026-11-07", status: "todo", why: "без него агенты не могут пушить файлы .github/workflows" },
    { id: "arena-model", owner: "lev", title: "Решить: менять модель домашней «Lain» на арене сейчас или с нового сезона", due: "2026-11-07", status: "todo", why: "сейчас там бесплатная модель, которая падает и держит позицию" },
    { id: "android-app", owner: "lev", title: "Решить, какое Android-приложение идёт в Google Play", due: "2026-11-08", status: "todo", why: "в репозиториях четыре разных приложения, два с одним appId" },
    { id: "home-page", owner: "lev", title: "Решить: главная lain-os.com — 3D-hero или «Less noise. More signal.»", due: "2026-11-08", status: "todo", why: "редизайн лежит в ветке wip/home-more-signal" },
    { id: "hatcher-letter", owner: "lev", title: "Написать Кристиану (HatcherLabs): их агент в лиге и итог Hatcher Cup 17 ноября", due: "2026-11-10", status: "todo", why: "сезон идёт с их брендом, а совместных постов нет" },
    { id: "x-analytics", owner: "lev", title: "Выгрузить X Analytics по обоим аккаунтам", due: "2026-11-10", status: "todo", why: "без выгрузки разбор KPI идёт вслепую" },
    { id: "cyberguard-offer", owner: "lev", title: "Решить, что предлагаем CyberGuard (Вик) за ревью протокола", due: "2026-11-12", status: "todo", why: "внешнее ревью — условие мейннета" },
    { id: "kpi-onboarding", owner: "orpheus", title: "Прочитать документ KPI и прийти на первый разбор в понедельник", due: "2026-11-09", status: "todo", why: "с 9 ноября меряем привычки", link: "https://claude.ai/artifact/MRCK2aD1E4cMpjVAyBpWQq (как работаем: https://chaos.fm/hub/docs/07-kak-rabotaem)" },
    { id: "cyberia-chain-daily", owner: "orpheus", title: "Каждый день пост в @cyberia_chain", due: "2026-11-09", status: "todo", why: "с 26 октября аккаунт молчит в X" },
    { id: "scenario-daily", owner: "orpheus", title: "Один сценарий продукта в день глазами новичка, баги — на доску /crm", due: "2026-11-09", status: "todo", why: "так находим, где люди спотыкаются" },
    { id: "arena-score", owner: "orpheus", title: "Ежедневный счёт арены: Лейн против Challenger", due: "2026-11-10", status: "todo", why: "арене нужны зрители" },
    { id: "launchpad-fuji", owner: "orpheus", title: "Лаунчпад на Cyberia 2.0: контракт и фронт", due: "2026-11-24", status: "todo", why: "сеть снова работает, задача с 25 октября" },
  ],
  log: [],
};
