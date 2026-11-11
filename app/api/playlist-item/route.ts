import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { DOWNLOADS_TEMP_DIR } from '@/lib/ytdlp';

export const dynamic = 'force-dynamic';

const MEDIA_EXT_RE = /\.(mp3|mp4|m4a|webm|mkv)$/i;

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.mp4': return 'video/mp4';
    case '.m4a': return 'audio/mp4';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    default: return 'application/octet-stream';
  }
}

/**
 * Serves one finished media file from a playlist download session.
 * Used by the "Download Files (No ZIP)" delivery mode: the client fetches each
 * file individually as soon as the progress stream marks it done. The file is
 * deleted after a successful transfer; when nothing remains, the whole session
 * directory is cleaned up.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session');
  const fileName = req.nextUrl.searchParams.get('file');

  if (!sessionId || !/^playlist_[\w-]+$/.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid or missing session id.' }, { status: 400 });
  }
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    return NextResponse.json({ error: 'Invalid file name.' }, { status: 400 });
  }

  const sessionDir = path.join(DOWNLOADS_TEMP_DIR, sessionId);
  const itemsDir = path.join(sessionDir, 'items');
  const filePath = path.join(itemsDir, fileName);

  // Path traversal guard: resolved path must stay inside the session items dir
  if (path.resolve(filePath) !== path.join(path.resolve(itemsDir), fileName)) {
    return NextResponse.json({ error: 'Invalid file name.' }, { status: 400 });
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    return NextResponse.json({ error: 'File not found for this session.' }, { status: 404 });
  }

  const ext = path.extname(fileName).toLowerCase();
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(fileName);

  const fileStream = fs.createReadStream(filePath);

  const cleanup = () => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
    // When no media files remain and no zip exists, drop the whole session
    try {
      const remainingMedia = fs.readdirSync(itemsDir).filter((f) => MEDIA_EXT_RE.test(f));
      const hasZip = fs.readdirSync(sessionDir).some((f) => f.endsWith('.zip'));
      if (remainingMedia.length === 0 && !hasZip) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch {}
  };
  fileStream.on('close', cleanup);
  fileStream.on('error', cleanup);

  return new Response(fileStream as any, {
    status: 200,
    headers: {
      'Content-Type': mimeForExt(ext),
      'Content-Length': stats.size.toString(),
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    },
  });
}
