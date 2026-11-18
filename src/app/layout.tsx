import type { Metadata, Viewport } from "next";
import "@fontsource/tajawal/latin-400.css";
import "@fontsource/tajawal/latin-500.css";
import "@fontsource/tajawal/latin-700.css";
import "@fontsource/tajawal/arabic-400.css";
import "@fontsource/tajawal/arabic-700.css";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Pagewise — PDF toolkit",
  description:
    "Merge, split, compress, convert, sign, redact, OCR and understand PDFs. Privacy-first: most tools run entirely in your browser.",
  applicationName: "Pagewise",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#171614" },
  ],
};

// Applies saved theme + direction BEFORE first paint (no FOUC).
const themeBootstrap = `(function(){try{var t=localStorage.getItem('pw-theme');if(t==='dark'){document.documentElement.classList.add('dark');}var d=localStorage.getItem('pw-dir')||'ltr';document.documentElement.dir=d;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen font-sans antialiased text-foreground [font-family:var(--font-body)]">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
