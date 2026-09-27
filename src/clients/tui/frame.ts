/**
 * One screen, assembled.
 *
 * `composeFrame` is the only place that knows how the pieces stack: the
 * transcript's visible slice with the scrollbar in its last column, the chrome
 * below it, the sidebar merged onto the right of both. It is pure — state in,
 * lines out — and it returns the hit map beside them, because the two are the
 * same arithmetic: a row's screen position is where it was drawn.
 *
 * The hit map used to be written out twice by hand (once as a ref's initial
 * value, once per render) and the two copies could disagree. Now there is one.
 */
import { blank, concat, fitLine, padLine, sp, truncateLine, type Line } from "./markdown.js";
import { scrollbarChar } from "./chrome.js";
import type { Theme } from "./theme.js";
import type { FeedRegion, SidebarRegion } from "./layout.js";

export type ComposerWrap = { text: string; start: number; end: number }[];

/** Where everything landed — what turns a mouse coordinate into a thing. */
export type FrameHit = {
  viewportRows: number;
  /** Screen row of the composer's first text line, or -1 when a picker owns it. */
  composerTop: number;
  composerWrap: ComposerWrap;
  contentW: number;
  width: number;
  sidebarOn: boolean;
  rows: number;
  menuTop: number;
  menuItems: readonly { name: string; desc: string }[];
  pickerTop: number;
  feedRegions: (FeedRegion | undefined)[];
  sidebarRegions: (SidebarRegion | undefined)[];
};

export type ChromeFrame = {
  lines: Line[];
  composerOffset: number;
  menuOffset: number;
  pickerOffset: number;
};

export function composeFrame(args: {
  theme: Theme;
  width: number;
  contentW: number;
  sidebarW: number;
  sidebarOn: boolean;
  frameRows: number;
  viewportRows: number;
  scrollTop: number;
  maxScroll: number;
  view: { lines: Line[]; regions: (FeedRegion | undefined)[] };
  chrome: ChromeFrame;
  sidebar: { lines: Line[]; regions: (SidebarRegion | undefined)[] };
  composerWrap: ComposerWrap;
  menuItems: readonly { name: string; desc: string }[];
}): { lines: Line[]; hit: FrameHit } {
  const { theme, width, contentW, sidebarW, sidebarOn, frameRows, viewportRows, scrollTop, maxScroll } = args;

  const slice = args.view.lines.slice(scrollTop, scrollTop + viewportRows);
  const sliceRegions = args.view.regions.slice(scrollTop, scrollTop + viewportRows);
  // The last column is always the scrollbar's, whether or not there is one to
  // draw: it keeps a code panel's border off the sidebar's, and the transcript
  // does not reflow the moment it grows past one screen.
  const trackW = Math.max(1, contentW - 1);
  const screenLines: Line[] = [];
  const feedRegions: (FeedRegion | undefined)[] = [];
  for (let i = 0; i < viewportRows; i++) {
    let l = slice[i] ?? blank(contentW);
    l = padLine(truncateLine(l, trackW), trackW);
    l = concat(l, [sp(scrollbarChar(i, viewportRows, maxScroll, scrollTop), theme.mutedDim)]);
    screenLines.push(l);
    feedRegions.push(sliceRegions[i]);
  }

  const lines: Line[] = [];
  for (let i = 0; i < frameRows; i++) {
    const l = i < viewportRows ? screenLines[i] : args.chrome.lines[i - viewportRows];
    if (!l) {
      lines.push(blank(width));
      continue;
    }
    lines.push(sidebarOn ? concat(fitLine(l, contentW), args.sidebar.lines[i] ?? blank(sidebarW)) : fitLine(l, width));
  }

  const below = (offset: number) => (offset < 0 ? -1 : viewportRows + offset);
  return {
    lines,
    hit: {
      viewportRows,
      composerTop: below(args.chrome.composerOffset),
      composerWrap: args.composerWrap,
      contentW,
      width,
      sidebarOn,
      rows: frameRows,
      menuTop: below(args.chrome.menuOffset),
      menuItems: args.menuItems,
      pickerTop: below(args.chrome.pickerOffset),
      feedRegions,
      sidebarRegions: args.sidebar.regions,
    },
  };
}
