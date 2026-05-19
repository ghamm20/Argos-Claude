"use client";

import { Eye } from "./Eye";
import { useArgos } from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";

export function ChatPane() {
  const personaId = useArgos((s) => s.personaId);
  const persona = PERSONA_BY_ID[personaId];

  return (
    <section className="flex-1 flex flex-col min-w-0">
      <div className="flex flex-col items-center justify-center pt-10 pb-6">
        <Eye />
        <div className="mt-4 text-[11px] uppercase tracking-[0.22em] text-neutral-500">
          {persona.name}
          <span
            className="ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ background: persona.iris }}
          />
        </div>
      </div>

      <div className="flex-1 px-10 py-4 overflow-y-auto">
        <div className="max-w-2xl mx-auto text-neutral-500 text-[13px] leading-relaxed">
          <p className="text-center text-neutral-600">
            Chat thread empty. Ollama loop wires up in Hour 2.
          </p>
        </div>
      </div>

      <div className="px-10 pb-8 pt-3 border-t border-neutral-800/60">
        <div className="max-w-2xl mx-auto">
          <div className="relative">
            <input
              type="text"
              disabled
              placeholder="Stubbed input — chat loop wires in Hour 2"
              className="w-full bg-neutral-900/60 border border-neutral-800 rounded-md pl-4 pr-20 py-3 text-[13px] text-neutral-300 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            />
            <button
              disabled
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider border border-neutral-700 text-neutral-500 cursor-not-allowed"
            >
              Send
            </button>
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-neutral-600 text-center">
            Network-off · Local-only inference
          </div>
        </div>
      </div>
    </section>
  );
}
