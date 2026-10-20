/**
 * X account analytics, as exported from the ads/analytics UI.
 *
 * Two files. The content export is one row per post (impressions, engagements,
 * follows that X attributed to that post). The overview export is one row per
 * day (follows gained and lost, posts created). Both come with Russian or
 * English headers depending on the locale of the export; the parser accepts
 * either. Pure: a string in, rows out, no clock and no disk.
 */

export interface AnalyticsPost {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  text: string;
  url: string;
  impressions: number;
  likes: number;
  engagements: number;
  bookmarks: number;
  shares: number;
  /** Follows X attributed to this post, not the account's net for the day. */
  newFollowers: number;
  replies: number;
  reposts: number;
  profileVisits: number;
  detailExpands: number;
  urlClicks: number;
}

export interface OverviewDay {
  date: string;
  impressions: number;
  engagements: number;
  newFollowers: number;
  lostFollowers: number;
  replies: number;
  reposts: number;
  profileVisits: number;
  /** Original posts the account created that day. Replies are not in this number. */
  postsCreated: number;
}

const CONTENT_COLUMNS: Record<string, keyof AnalyticsPost> = {
  "идентификатор поста": "id",
  "post id": "id",
  id: "id",
  дата: "date",
  date: "date",
  "текст поста": "text",
  "post text": "text",
  text: "text",
  "ссылка на пост": "url",
  link: "url",
  url: "url",
  показы: "impressions",
  impressions: "impressions",
  нравится: "likes",
  likes: "likes",
  взаимодействия: "engagements",
  engagements: "engagements",
  закладки: "bookmarks",
  bookmarks: "bookmarks",
  поделились: "shares",
  shares: "shares",
  "новые читатели": "newFollowers",
  "new followers": "newFollowers",
  ответы: "replies",
  replies: "replies",
  репосты: "reposts",
  reposts: "reposts",
  "посещения профиля": "profileVisits",
  "profile visits": "profileVisits",
  "разворачивания подробных сведений": "detailExpands",
  "detail expands": "detailExpands",
  "клики по url-адресам": "urlClicks",
  "url clicks": "urlClicks",
};

const OVERVIEW_COLUMNS: Record<string, keyof OverviewDay> = {
  дата: "date",
  date: "date",
  показы: "impressions",
  impressions: "impressions",
  взаимодействия: "engagements",
  engagements: "engagements",
  "новые читатели": "newFollowers",
  "new followers": "newFollowers",
  "потерянные читатели": "lostFollowers",
  "lost followers": "lostFollowers",
  ответы: "replies",
  replies: "replies",
  репосты: "reposts",
  reposts: "reposts",
  "посещения профиля": "profileVisits",
  "profile visits": "profileVisits",
  "создать пост": "postsCreated",
  posts: "postsCreated",
  "posts created": "postsCreated",
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Sat, Oct 17, 2026" or "2026-10-17" → YYYY-MM-DD. Empty when it cannot be read. */
export function parseAnalyticsDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^[A-Za-z]{3},?\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return "";
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return "";
  const day = Number(m[2]);
  if (day < 1 || day > 31) return "";
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[\s,]/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * A small RFC-style CSV reader. Fields may be quoted, quotes are doubled, and
 * a quoted field may contain commas. Exports from X are one row per record,
 * but a quoted newline is still handled so a post that contains one survives.
 */
export function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

function indexHeaders<T extends string>(
  header: string[],
  columns: Record<string, T>,
  required: T[],
  label: string,
): Map<T, number> {
  const index = new Map<T, number>();
  header.forEach((cell, i) => {
    const key = columns[cell.trim().toLowerCase()];
    if (key && !index.has(key)) index.set(key, i);
  });
  const missing = required.filter((name) => !index.has(name));
  if (missing.length) {
    throw new Error(
      `${label} is missing ${missing.join(", ")}. Headers were: ${header.filter(Boolean).join(", ") || "(none)"}`,
    );
  }
  return index;
}

function cell<T extends string>(row: string[], index: Map<T, number>, key: T): string {
  const at = index.get(key);
  return at === undefined ? "" : (row[at] ?? "");
}

export function parseContentAnalytics(raw: string): AnalyticsPost[] {
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error("content analytics export is empty");
  const [header, ...body] = rows;
  const index = indexHeaders(header, CONTENT_COLUMNS, ["date", "text", "impressions", "newFollowers"], "content analytics");
  const posts: AnalyticsPost[] = [];
  for (const row of body) {
    const date = parseAnalyticsDate(cell(row, index, "date"));
    const text = cell(row, index, "text").trim();
    if (!date || !text) continue;
    posts.push({
      id: cell(row, index, "id").trim(),
      date,
      text,
      url: cell(row, index, "url").trim(),
      impressions: parseNumber(cell(row, index, "impressions")),
      likes: parseNumber(cell(row, index, "likes")),
      engagements: parseNumber(cell(row, index, "engagements")),
      bookmarks: parseNumber(cell(row, index, "bookmarks")),
      shares: parseNumber(cell(row, index, "shares")),
      newFollowers: parseNumber(cell(row, index, "newFollowers")),
      replies: parseNumber(cell(row, index, "replies")),
      reposts: parseNumber(cell(row, index, "reposts")),
      profileVisits: parseNumber(cell(row, index, "profileVisits")),
      detailExpands: parseNumber(cell(row, index, "detailExpands")),
      urlClicks: parseNumber(cell(row, index, "urlClicks")),
    });
  }
  if (!posts.length) throw new Error("content analytics export has headers but no readable posts");
  return posts;
}

export function parseOverviewAnalytics(raw: string): OverviewDay[] {
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error("overview analytics export is empty");
  const [header, ...body] = rows;
  const index = indexHeaders(
    header,
    OVERVIEW_COLUMNS,
    ["date", "newFollowers", "postsCreated"],
    "overview analytics",
  );
  const days: OverviewDay[] = [];
  for (const row of body) {
    const date = parseAnalyticsDate(cell(row, index, "date"));
    if (!date) continue;
    days.push({
      date,
      impressions: parseNumber(cell(row, index, "impressions")),
      engagements: parseNumber(cell(row, index, "engagements")),
      newFollowers: parseNumber(cell(row, index, "newFollowers")),
      lostFollowers: parseNumber(cell(row, index, "lostFollowers")),
      replies: parseNumber(cell(row, index, "replies")),
      reposts: parseNumber(cell(row, index, "reposts")),
      profileVisits: parseNumber(cell(row, index, "profileVisits")),
      postsCreated: parseNumber(cell(row, index, "postsCreated")),
    });
  }
  if (!days.length) throw new Error("overview analytics export has headers but no readable days");
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}
