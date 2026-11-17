"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  buildTourSteps,
  parseTourState,
  startTour,
  TOUR_SEEN_KEY,
  TOUR_STATE_KEY,
  tourReducer,
  type TourAction,
  type TourState,
  type TourStep,
} from "./tour-steps.ts";

/**
 * The guided tour of the staff pages (the logic is tour-steps.ts). The provider lives in the realty layout: it auto-runs once
 * for a first-time viewer (autoStart, read on the server), and the "Start tour" button in the header replays it. The step in
 * progress is kept in sessionStorage so a reload resumes it. Going to a step's page is a router.push; the step spotlights its
 * data-tour target when that page is showing, and otherwise shows the card centred.
 */

type TourContextValue = { start: () => void };
const TourContext = createContext<TourContextValue>({ start: () => {} });

/** The header's Start tour button uses this. */
export function useDeskTour(): TourContextValue {
  return useContext(TourContext);
}

export function DeskTourProvider({
  owner,
  teacher,
  signedIn,
  autoStart,
  children,
}: {
  owner: boolean;
  teacher: boolean;
  /** Whether the viewer has a session email. With none (gate off), the "seen" flag lives in localStorage. */
  signedIn: boolean;
  /** Server's answer: the viewer hasn't seen the tour yet (shouldAutoStart). */
  autoStart: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const steps = useMemo(() => buildTourSteps({ owner, teacher }), [owner, teacher]);
  const [state, setState] = useState<TourState | null>(null);
  const stateRef = useRef<TourState | null>(null);
  const pathRef = useRef(pathname);
  const started = useRef(false);

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const apply = useCallback((next: TourState | null) => {
    stateRef.current = next;
    setState(next);
    try {
      if (next) sessionStorage.setItem(TOUR_STATE_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(TOUR_STATE_KEY);
    } catch {
      // Private mode or storage off: the tour still works, it just won't survive a reload.
    }
  }, []);

  const dispatch = useCallback((action: TourAction) => apply(tourReducer(stateRef.current, action, steps.length)), [apply, steps.length]);

  const markSeen = useCallback(() => {
    if (signedIn) {
      void fetch("/api/realty/tour", { method: "POST", keepalive: true }).catch(() => {});
    } else {
      try {
        localStorage.setItem(TOUR_SEEN_KEY, new Date().toISOString());
      } catch {
        // Storage off: the tour may run again next time. Nothing else to do.
      }
    }
  }, [signedIn]);

  // Once per mount: resume a tour in progress (a reload, or a fresh tab mid-tour), else auto-run for a first-time viewer.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let saved: TourState | null = null;
    try {
      saved = parseTourState(sessionStorage.getItem(TOUR_STATE_KEY));
    } catch {
      saved = null;
    }
    // Reading sessionStorage can only happen after mount (there is none on the server), so this sets state from the effect on
    // purpose. It runs once per mount, so there is no render loop.
    if (saved && saved.index < steps.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      apply(saved);
      return;
    }
    let seenHere = false;
    try {
      seenHere = !signedIn && localStorage.getItem(TOUR_SEEN_KEY) !== null;
    } catch {
      seenHere = false;
    }
    if (autoStart && !seenHere) {
      markSeen(); // marked as soon as it starts: a reload mid-tour resumes it, it never auto-runs a second time
      apply(startTour());
    }
  }, [apply, autoStart, markSeen, signedIn, steps.length]);

  // Each step's page: go there first. Only when the step changes, so the viewer can still move around on their own.
  const index = state?.index ?? null;
  const wantedPage = index === null ? null : (steps[index]?.page ?? null);
  useEffect(() => {
    if (wantedPage && pathRef.current !== wantedPage) router.push(wantedPage);
  }, [index, wantedPage, router]);

  // Esc skips the tour.
  const running = state !== null;
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "skip" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, dispatch]);

  const start = useCallback(() => apply(startTour()), [apply]);
  const step = index === null ? undefined : steps[index];

  return (
    <TourContext.Provider value={{ start }}>
      {children}
      {state && step ? (
        <TourOverlay
          key={step.id}
          step={step}
          index={state.index}
          total={steps.length}
          onPage={step.page === null || step.page === pathname}
          onBack={() => dispatch({ type: "back" })}
          onNext={() => dispatch({ type: "next" })}
          onSkip={() => dispatch({ type: "skip" })}
        />
      ) : null}
    </TourContext.Provider>
  );
}

/** The header's Start tour button. Replays the tour from the welcome card, whether or not it was seen. */
export function StartTourButton() {
  const { start } = useDeskTour();
  return (
    <button type="button" className="rt-chip" onClick={start} data-tour="start-tour">
      Start tour
    </button>
  );
}

type Box = { top: number; left: number; width: number; height: number };

const CARD_W = 320;
const CARD_H = 210; // a generous estimate of the card's height, for placing it beside the target

function TourOverlay({
  step,
  index,
  total,
  onPage,
  onBack,
  onNext,
  onSkip,
}: {
  step: TourStep;
  index: number;
  total: number;
  /** The step's page is showing (always true for steps without a page). */
  onPage: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [box, setBox] = useState<Box | null>(null);

  // Find the target (it may not be on the page yet, or may not exist on this page), scroll it into view once, and keep its
  // box up to date while the step is showing. No target on the page: the box stays null and the card is centred.
  useEffect(() => {
    if (!step.target || !onPage) return;
    let scrolled = false;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!el) {
        setBox((prev) => (prev === null ? prev : null));
        return;
      }
      if (!scrolled) {
        scrolled = true;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const r = el.getBoundingClientRect();
      setBox((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    tick();
    const id = window.setInterval(tick, 200);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", tick);
    };
  }, [step.target, onPage]);

  const spotlight = onPage && box ? box : null;
  const cardStyle = cardPosition(step.card === "near" ? spotlight : null);
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <>
      {spotlight ? (
        <>
          <div className="fixed inset-0 z-[1000]" aria-hidden />
          <div
            aria-hidden
            className="pointer-events-none fixed z-[1000] rounded-xl"
            style={{
              top: spotlight.top - 6,
              left: spotlight.left - 6,
              width: spotlight.width + 12,
              height: spotlight.height + 12,
              boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.6)",
              outline: "2px solid hsl(var(--accent))",
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 z-[1000] bg-slate-900/60" aria-hidden />
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-tour-title"
        aria-describedby="desk-tour-text"
        className="rt-card fixed z-[1001] grid gap-3 p-5 shadow-xl"
        style={cardStyle}
      >
        <p className="rt-muted text-xs">
          Step {index + 1} of {total}
        </p>
        <h2 id="desk-tour-title" className="text-lg font-semibold">
          {step.title}
        </h2>
        <p id="desk-tour-text" className="text-sm">
          {step.text}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="rt-muted text-sm underline-offset-2 hover:underline" onClick={onSkip}>
            Skip tour
          </button>
          <div className="flex gap-2">
            <button type="button" className="rt-chip" onClick={onBack} disabled={isFirst}>
              Back
            </button>
            <button type="button" className="rt-btn" onClick={isLast ? onSkip : onNext} autoFocus>
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Where the card goes: centred, or beside the spotlight (below it if there is room, else above, else at the bottom). */
function cardPosition(box: Box | null): CSSProperties {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  const width = Math.min(CARD_W, vw - 32);
  if (!box) return { top: "50%", left: "50%", transform: "translate(-50%, -50%)", width };
  const left = Math.min(Math.max(box.left, 16), vw - width - 16);
  const bottom = box.top + box.height;
  if (vh - bottom >= CARD_H + 16) return { top: bottom + 12, left, width };
  if (box.top >= CARD_H + 16) return { top: box.top - CARD_H - 12, left, width };
  return { top: Math.max(16, vh - CARD_H - 16), left, width };
}
