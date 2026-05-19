import { create } from "zustand";
import { PERSONA_BY_ID, type PersonaId } from "./personas";

interface ArgosState {
  personaId: PersonaId;
  setPersona: (id: PersonaId) => void;
  iris: () => string;
  personaName: () => string;
}

export const useArgos = create<ArgosState>((set, get) => ({
  personaId: "bartimaeus",
  setPersona: (id) => set({ personaId: id }),
  iris: () => PERSONA_BY_ID[get().personaId].iris,
  personaName: () => PERSONA_BY_ID[get().personaId].name,
}));
