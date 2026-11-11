// ALNOKHBA QB — unified build entry.
// Vercel (@vercel/next in builds mode) and local/VPS both run `bun run build`.
//  - always: next build (Prisma generate happens in postinstall)
//  - NOT on Vercel: pack standalone output + chrome (next.config skips
//    `output: standalone` on Vercel, so .next/standalone never exists there)
import { execSync } from 'child_process';

execSync('next build', { stdio: 'inherit' });

if (!process.env.VERCEL) {
  execSync(
    'cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/ && node scripts/pack-chrome.mjs',
    { stdio: 'inherit', shell: '/bin/bash' }
  );
}
