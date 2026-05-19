"use client";

interface CitationPillProps {
  n: number;
  accent: string;
  onClick: () => void;
}

export function CitationPill({ n, accent, onClick }: CitationPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-citation={n}
      className="inline-flex items-center justify-center mx-0.5 px-1.5 min-w-[20px] h-[18px] rounded-sm text-[10px] font-mono leading-none align-baseline border transition-colors hover:brightness-125"
      style={{
        borderColor: `${accent}55`,
        color: accent,
        background: `${accent}1a`,
      }}
      title="Show source chunk"
    >
      [{n}]
    </button>
  );
}
