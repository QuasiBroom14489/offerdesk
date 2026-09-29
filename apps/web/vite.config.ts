import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Hosted builds sign in with Clerk. The Vercel integration names the key
    // the Next.js way; a local build has neither and runs without sign-in.
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(
      process.env.VITE_CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
    ),
  },
  server: {
    port: 5417,
    proxy: { '/api': 'http://127.0.0.1:4417' },
  },
});
