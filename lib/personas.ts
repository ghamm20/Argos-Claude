export type PersonaId = "bartimaeus" | "juniper" | "sage" | "bobby";

export interface Persona {
  id: PersonaId;
  name: string;
  iris: string;
  status: "live" | "selectable";
}

export const PERSONAS: Persona[] = [
  { id: "bartimaeus", name: "Bartimaeus", iris: "#10b981", status: "live" },
  { id: "juniper", name: "Juniper", iris: "#84cc16", status: "selectable" },
  { id: "sage", name: "Sage", iris: "#eab308", status: "selectable" },
  { id: "bobby", name: "Bobby", iris: "#3b82f6", status: "selectable" },
];

export const PERSONA_BY_ID: Record<PersonaId, Persona> = Object.fromEntries(
  PERSONAS.map((p) => [p.id, p])
) as Record<PersonaId, Persona>;
