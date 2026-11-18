import type { Metadata, Viewport } from "next";
import "@fontsource/tajawal/arabic-400.css";
import "@fontsource/tajawal/arabic-500.css";
import "@fontsource/tajawal/arabic-700.css";
import "@fontsource/tajawal/latin-400.css";
import "@fontsource/tajawal/latin-700.css";
import "@fontsource/amiri/arabic-400.css";
import "@fontsource/amiri/arabic-700.css";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "النخبة QB — بنك الأسئلة والتصحيح الآلي",
  description:
    "نظام بنك الأسئلة: مصمم امتحانات، محرك PDF، مولّد أوراق OMR، قارئ ضوئي وتصحيح آلي بنموذج امتحاني واحد.",
};

export const viewport: Viewport = {
  themeColor: "#0b1714",
};

// Applies the saved theme BEFORE first paint (no FOUC). Dark = the default
// "Midnight Luxe" identity; light stays available via the header toggle.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('anqb-theme');if(t!=='light'){document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen font-sans antialiased text-foreground [font-family:Tajawal,system-ui,sans-serif]">
        <div className="app-aurora" aria-hidden="true" />
        <div className="app-grid" aria-hidden="true" />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
