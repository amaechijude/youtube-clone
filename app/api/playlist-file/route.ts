import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Serves a finished playlist zip archive produced by /api/playlist-download.
 * The client calls this after the NDJSON progress stream reports "complete".
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session');

  if (!sessionId || !/^playlist_[\w-]+$/.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid or missing session id.' }, { status: 400 });
  }

  // Type-safe access to the module-level registry owned by the download route.
  const registry = (globalThis as any).__playlistPendingZips as Map<string, { zipPath: string; zipName: string }> | undefined;

  let zipPath: string;
  if (registry && registry.has(sessionId)) {
    zipPath = registry.get(sessionId)!.zipPath;
  } else {
    // Fallback: accept the session path directly if it still exists
    // (e.g. after a dev-server hot reload cleared module state).
    zipPath = path.join(path.join(process.cwd(), '.temp_downloads'), sessionId);
    if (!fs.existsSync(zipPath)) {
      return NextResponse.json({ error: 'Download session not found or expired.' }, { status: 404 });
    }
  }

  const zipFile = fs.readdirSync(zipPath).find((f) => f.endsWith('.zip'));
  if (!zipFile) {
    return NextResponse.json({ error: 'Archive not found for this session.' }, { status: 404 });
  }

  const zipFilePath = path.join(zipPath, zipFile);
  const zipStats = fs.statSync(zipFilePath);
  const asciiZipName = zipFile.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedZipName = encodeURIComponent(zipFile);

  const fileStream = fs.createReadStream(zipFilePath);

  // Clean up the whole session (zip + items) once the transfer is done
  const cleanup = () => {
    try {
      fs.rmSync(zipPath, { recursive: true, force: true });
    } catch {}
    registry?.delete(sessionId);
  };
  fileStream.on('close', cleanup);
  fileStream.on('error', cleanup);

  return new Response(fileStream as any, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': zipStats.size.toString(),
      'Content-Disposition': `attachment; filename="${asciiZipName}"; filename*=UTF-8''${encodedZipName}`,
      'Cache-Control': 'no-store',
    },
  });
}
