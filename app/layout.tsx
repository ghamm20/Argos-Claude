import type { Metadata, Viewport } from "next";
import "./globals.css";
// Operator Auth (2026-05-28) — PinGate wraps every page. It self-
// disables when settings.requirePin === false, so the pre-auth
// behavior is preserved until the operator explicitly enables the gate.
import { PinGate } from "@/components/auth/PinGate";

export const metadata: Metadata = {
  title: "ARGOS",
  description: "USB-native local AI workstation",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans">
        <PinGate>{children}</PinGate>
      </body>
    </html>
  );
}
