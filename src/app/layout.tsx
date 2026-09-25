import type { Metadata, Viewport } from "next";
import { getLocale } from "@/i18n/server";
import { dir } from "@/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriveDesk",
  description: "Lessons, students, instructors, payments and WhatsApp for driving schools.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#1f6feb" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dir(locale)}>
      <body>{children}</body>
    </html>
  );
}
