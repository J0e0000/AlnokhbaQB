import type { Metadata } from "next";
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
    "صمّم الامتحان، اطبع أوراق الإجابة، امسح وصحّح دفعة كاملة في دقائق.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased text-foreground">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
