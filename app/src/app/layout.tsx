import type { Metadata } from "next";
import { env } from "@/lib/env";
import "./globals.css";

export function generateMetadata(): Metadata {
  const name = process.env.PROJECT_NAME ? env.projectName : "Holder";
  return {
    title: `${name} · verify`,
    description: `Prove you hold ${name} and unlock the Discord. Signing is free and moves nothing.`,
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
