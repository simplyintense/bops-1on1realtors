import { navTourId, visibleStaffPages } from "./staff-pages.ts";
import { SIDEBAR_DESK_HREFS } from "./sidebar-model.ts";

/**
 * The guided tour of the staff pages, as plain data and plain functions (no React), so a test can check the steps, the
 * roles and the copy. The overlay that shows them is desk-tour.tsx; the "seen" store is realty/node/tour-seen.ts.
 *
 * The tour is: a welcome card, then for each page the viewer can see (in nav order) the page's nav link (only when the sidebar
 * shows that link, see SIDEBAR_DESK_HREFS) followed by the page's key sections, then a closing card that points at the Start
 * tour button. The Bops chat app at "/" is never in the tour.
 */

export const TOUR_SEEN_KEY = "desk-tour-seen"; // localStorage, only when there is no signed-in email (gate off)
export const TOUR_STATE_KEY = "desk-tour-state"; // sessionStorage: the step in progress, so a reload or a page change resumes it

export type TourStep = {
  id: string;
  /** The page (href) this step is on. The tour navigates there first. null: the step stays on the current page. */
  page: string | null;
  /** The data-tour id to spotlight. null: no spotlight, the card is centred. */
  target: string | null;
  /** "centre": the card is always centred (welcome and closing); "near": next to the target, or centred if there is none. */
  card: "near" | "centre";
  title: string;
  text: string;
};

export type TourState = { index: number };
export type TourAction = { type: "next" } | { type: "back" } | { type: "skip" } | { type: "start" };

type Copy = { title: string; text: string };
type Section = Copy & { key: string; target: string };

export const WELCOME: Copy = {
  title: "Welcome to the 1on1 Desk",
  text: "This desk helps you find buyer matches and listings faster. Here's a quick look around.",
};

export const CLOSING: Copy = {
  title: "All set",
  text: "That's it. You can replay this tour any time with Start tour.",
};

/** Each page's nav copy and key sections, keyed by the page's href. Targets are data-tour ids in the page's source. */
const PAGES: Record<string, { nav: Copy; sections: Section[] }> = {
  "/realty/desk": {
    nav: { title: "Desk", text: "Desk is your home page. It shows matches for you and shortcuts to your tools." },
    sections: [
      { key: "search", target: "desk-search", title: "Online search", text: "Search other agencies' listings for any area, with filters." },
      { key: "portal", target: "desk-portal", title: "Agent portal", text: "Opens the 1on1 agent portal in a new tab, same as before." },
      {
        key: "leads",
        target: "desk-leads",
        title: "Automatch leads",
        text: "Buyer requests that strongly match a listing you hold, with a suggested first message you can send yourself.",
      },
      {
        key: "recs",
        target: "desk-recs",
        title: "Top recommendations",
        text: "Matches for the requests you post on WhatsApp, and requests that fit your listings. Mark each one Contacted, Not a fit or Closed so the list stays tidy.",
      },
    ],
  },
  "/realty/automatch": {
    nav: { title: "Automatch", text: "Buyer requests matched against your listings, with the strongest matches first." },
    sections: [
      { key: "leads", target: "automatch-leads", title: "Lead cards", text: "Each strong match with who asked, the listing, and a suggested first message." },
      { key: "pairs", target: "automatch-pairs", title: "All pairs", text: "Every pair, strongest first. Switch to 50 and above to see the fair matches too." },
    ],
  },
  "/realty/search": {
    nav: { title: "Market Search", text: "Listings and buyer requests from the WhatsApp groups, in one place. Read-only." },
    sections: [
      { key: "tabs", target: "search-tabs", title: "Supply, demand and more", text: "Pick the kind of post you want to look at." },
      { key: "filters", target: "search-filters", title: "Filters", text: "Narrow it down by keyword, area, price, beds or type." },
    ],
  },
  "/realty/posts": {
    nav: { title: "All posts", text: "The posts stored from the WhatsApp groups, with the original text next to what the desk read." },
    sections: [{ key: "list", target: "posts-list", title: "Posts", text: "Open a post to see its original text and what was matched from it." }],
  },
  "/realty/market": {
    nav: { title: "Online search", text: "Online search looks across other agencies' listings." },
    sections: [
      { key: "filters", target: "market-filters", title: "Filters", text: "Pick an area, price and type to narrow the list." },
      { key: "stats", target: "market-stats", title: "At a glance", text: "How many listings and areas the market shows right now." },
      { key: "results", target: "market-results", title: "Results", text: "Tap a listing to see photos and the listing agent's contact details." },
    ],
  },
  "/realty/digest": {
    nav: { title: "Digest", text: "The last day's buyer requests from the WhatsApp group, and the matches for them." },
    sections: [
      { key: "requests", target: "digest-requests", title: "Last 24 hours", text: "The buyer requests that came in, each with its matches." },
      { key: "replay", target: "digest-replay", title: "Replay", text: "A dry run with sample messages. Nothing is sent from here." },
    ],
  },
  "/realty/alerts": {
    nav: { title: "Auto-Match Alert", text: "A preview of the emails agents get for strong matches. Nothing goes out from here except a test." },
    sections: [
      { key: "summary", target: "alerts-summary", title: "Counts", text: "How many emails would go out, and how many are held back for now." },
      { key: "emails", target: "alerts-emails", title: "The emails", text: "Each one as the agent would see it, with who it goes to." },
    ],
  },
  "/realty/learn": {
    nav: { title: "Teach", text: "Help the desk learn new areas and answer its questions." },
    sections: [
      { key: "questions", target: "learn-questions", title: "Open questions", text: "Policy questions for the owner. Answers here change nothing in matching." },
      { key: "queue", target: "learn-queue", title: "Posts to explain", text: "Posts too vague to match yet. A one-line answer teaches the desk for every future post." },
    ],
  },
};

/** The steps for this viewer: welcome, then each visible page in nav order (the nav link, then its sections), then closing. */
export function buildTourSteps(viewer: { owner: boolean; teacher: boolean }): TourStep[] {
  const steps: TourStep[] = [{ id: "welcome", page: null, target: null, card: "centre", ...WELCOME }];
  for (const p of visibleStaffPages(viewer)) {
    const page = PAGES[p.href];
    if (p.href === "/" || !page) continue; // the Bops chat app is not part of the tour
    const slug = p.href.split("/").pop();
    if (SIDEBAR_DESK_HREFS.includes(p.href)) {
      steps.push({ id: `${slug}:nav`, page: p.href, target: navTourId(p.href), card: "near", title: page.nav.title, text: page.nav.text });
    }
    for (const s of page.sections) {
      steps.push({ id: `${slug}:${s.key}`, page: p.href, target: s.target, card: "near", title: s.title, text: s.text });
    }
  }
  steps.push({ id: "closing", page: null, target: "start-tour", card: "centre", ...CLOSING });
  return steps;
}

/** A visitor's first load auto-runs the tour; once it has run (finished, skipped or closed) it never does again. */
export function shouldAutoStart(seen: boolean): boolean {
  return !seen;
}

/** The state at the first step. Replay (Start tour) always begins here, whether or not the tour was seen before. */
export function startTour(): TourState {
  return { index: 0 };
}

/** Pure reducer. count is the number of steps. Next on the last step ends the tour (null); skip ends it from any step. */
export function tourReducer(state: TourState | null, action: TourAction, count: number): TourState | null {
  if (action.type === "start") return startTour();
  if (!state) return null;
  if (action.type === "skip") return null;
  if (action.type === "back") return { index: Math.max(0, state.index - 1) };
  return state.index + 1 >= count ? null : { index: state.index + 1 };
}

/** The saved in-progress state from sessionStorage, or null if there is none or it isn't valid. */
export function parseTourState(raw: string | null | undefined): TourState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    const index = (v as { index?: unknown } | null)?.index;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 ? { index } : null;
  } catch {
    return null;
  }
}
