"use client";

import type { ReactNode } from "react";
import { LeftRail } from "./LeftRail";
import { HUD } from "./HUD";
import { CitationDrawer } from "./CitationDrawer";

interface StubPageProps {
  argosRoot: string;
  version: string;
  startedAt: number;
  title: string;
  status: string;
  weekLabel: string;
  children: ReactNode;
}

export function StubPage({
  argosRoot,
  version,
  startedAt,
  title,
  status,
  weekLabel,
  children,
}: StubPageProps) {
  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <section
        data-stub-page={title.toLowerCase()}
        className="flex-1 flex flex-col min-w-0 overflow-hidden"
      >
        <div className="px-10 pt-6 pb-4 border-b border-neutral-800/60">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[22px] font-semibold tracking-wide text-neutral-100">
              {title}
            </div>
            <span
              data-testid="stub-status"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-[10px] uppercase tracking-[0.2em] border-amber-500/40 text-amber-400 bg-amber-500/10"
              title="Not in v1 — see docs/02-SCOPE-LOCK.md"
            >
              {status}
            </span>
            <span
              data-testid="stub-week"
              className="inline-flex items-center px-2 py-0.5 rounded-sm border text-[10px] uppercase tracking-[0.2em] border-neutral-700 text-neutral-400"
            >
              {weekLabel}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mt-2">
            Local · USB-native · Path B build
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-10 py-6">
          <div className="max-w-2xl space-y-8">{children}</div>
        </div>
      </section>
      <HUD argosRoot={argosRoot} version={version} startedAt={startedAt} />
      <CitationDrawer />
    </main>
  );
}

export function StubSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div data-stub-section={title.toLowerCase().replace(/\s+/g, "-")}>
      <div className="text-[10px] uppercase tracking-[0.22em] text-neutral-500 mb-2.5">
        {title}
      </div>
      <div className="rounded-md border border-neutral-800/70 bg-black/30 px-4 py-4 space-y-2 text-[13px] leading-relaxed text-neutral-300">
        {children}
      </div>
    </div>
  );
}

export function StubBullet({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-2 h-1 w-1 rounded-full bg-neutral-600 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function StubQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote
      className="border-l-2 border-neutral-700 pl-3 py-1 text-[12px] italic text-neutral-400"
      data-stub-quote
    >
      {children}
    </blockquote>
  );
}
