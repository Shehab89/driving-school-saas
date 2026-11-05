import type { Metadata, Viewport } from "next";
import { getLocale } from "@/i18n/server";
import { dir } from "@/i18n";
import { ChartTips } from "@/components/chart-tips";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriveDesk",
  description: "Lessons, students, instructors, payments and WhatsApp for driving schools.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f6f7f8" }, { media: "(prefers-color-scheme: dark)", color: "#0e1013" }] };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dir(locale)}>
      <body>
        {children}
        <ChartTips />
      </body>
    </html>
  );
}
