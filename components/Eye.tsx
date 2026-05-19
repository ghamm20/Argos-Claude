"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { useArgos } from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";

export function Eye() {
  const iris = useArgos((s) => PERSONA_BY_ID[s.personaId].iris);
  const [hover, setHover] = useState(false);

  return (
    <motion.svg
      width={200}
      height={200}
      viewBox="0 0 200 200"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      animate={{ scale: [1, 1.02, 1] }}
      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      style={{ filter: hover ? `drop-shadow(0 0 12px ${iris}80)` : "none" }}
      role="img"
      aria-label="ARGOS eye"
    >
      <defs>
        <radialGradient id="argos-sclera" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#1f1f1f" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </radialGradient>
        <radialGradient id="argos-iris" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={iris} stopOpacity={0.9} />
          <stop offset="70%" stopColor={iris} stopOpacity={0.6} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.9} />
        </radialGradient>
      </defs>

      <ellipse
        cx={100}
        cy={100}
        rx={92}
        ry={56}
        fill="url(#argos-sclera)"
        stroke="#2a2a2a"
        strokeWidth={1.5}
      />

      <circle
        cx={100}
        cy={100}
        r={42}
        fill="url(#argos-iris)"
        stroke={iris}
        strokeOpacity={0.4}
        strokeWidth={1}
      />

      <circle cx={100} cy={100} r={16} fill="#000" />

      <circle cx={88} cy={88} r={6} fill="#ffffff" fillOpacity={0.85} />
      <circle cx={114} cy={106} r={2.5} fill="#ffffff" fillOpacity={0.5} />
    </motion.svg>
  );
}
