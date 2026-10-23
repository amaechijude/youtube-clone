import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'YouTube & YouTube Music Pro Downloader',
  description: 'Download single videos, audios, convert to high-fidelity MP3, or export entire playlists with quality selection and live file size guides.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased selection:bg-rose-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
