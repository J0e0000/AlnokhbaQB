import { AppShell } from '@/components/shell/AppShell';

// Shell layout: RTL sidebar (desktop) + bottom bar (mobile) around every page.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
