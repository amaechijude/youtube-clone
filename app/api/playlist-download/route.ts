import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { YTDLP_PATH, DOWNLOADS_TEMP_DIR, sanitizeFilename } from '@/lib/ytdlp';

export const dynamic = 'force-dynamic';

// Progress events are streamed to the client as newline-delimited JSON (NDJSON).
// Each line is a self-contained JSON object:
//   { "type": "item", "index": 3, "title": "...", "status": "downloading", "percent": 42 }
//   { "type": "phase", "phase": "downloading" | "zipping" }
//   { "type": "complete", "sessionId": "...", "zipName": "...", "zipSize": 12345, "succeeded": 9, "failed": 1 }
//   { "type": "error", "message": "..." }

// Finished zip archives waiting to be picked up by /api/playlist-file.
// Kept on disk until downloaded or until the TTL expires. The registry lives on
// globalThis so it is shared with the playlist-file route in the same process.
type PendingZip = { zipPath: string; zipName: string; createdAt: number };
const pendingZips: Map<string, PendingZip> = ((globalThis as any).__playlistPendingZips ??= new Map());
const ZIP_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleZips() {
  const now = Date.now();
  for (const [id, entry] of pendingZips) {
    if (now - entry.createdAt > ZIP_TTL_MS) {
      try {
        fs.rmSync(path.dirname(entry.zipPath), { recursive: true, force: true });
      } catch {}
      pendingZips.delete(id);
    }
  }
}

export async function POST(req: NextRequest) {
  cleanupStaleZips();

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { items, playlistTitle, format = 'mp3', quality } = body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'No items selected for download.' }, { status: 400 });
  }

  const sessionId = `playlist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionDir = path.join(DOWNLOADS_TEMP_DIR, sessionId);
  const mediaDir = path.join(sessionDir, 'items');

  fs.mkdirSync(mediaDir, { recursive: true });

  const isMp3Export = format === 'mp3';
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true;
        }
      };

      try {
        console.log(`[Playlist Download] Starting batch of ${items.length} items (format: ${format})`);
        send({ type: 'phase', phase: 'downloading' });

        // Download a single item. Always resolves; failures are reported via the
        // returned result and a progress event so one bad item never aborts the rest.
        // Progress is parsed live from yt-dlp's stdout ([download]  XX.X% lines).
        const downloadItem = (item: any, index: number): Promise<{ ok: boolean }> => new Promise((resolve) => {
          // The client indexes progress bars by the original playlist row index,
          // so pass it through even though the batch order may differ.
          const entryIndex = typeof item.entryIndex === 'number' ? item.entryIndex : index;
          const sendItem = (status: string, percent?: number, error?: string) => {
            send({ type: 'item', index: entryIndex, title: item.title, status, percent, ...(error ? { error } : {}) });
          };

          const itemIndexStr = String(index + 1).padStart(2, '0');
          const itemTitle = sanitizeFilename(item.title || `Track ${index + 1}`);

          const args = [
            '--js-runtimes', 'node',
            '--no-playlist',
            '--no-warnings',
            // Force yt-dlp to print each progress update on its own stdout line
            // so we can parse live download percentages reliably.
            '--newline',
          ];

          if (isMp3Export) {
            args.push(
              '-x',
              '--audio-format', 'mp3',
              '--audio-quality', '0',
              '-f', 'ba/b',
              '--embed-thumbnail',
              '--embed-metadata',
              '--convert-thumbnails', 'jpg'
            );
          } else {
            // Video
            if (quality && !isNaN(Number(quality))) {
              args.push(
                '-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
                '--merge-output-format', 'mp4'
              );
            } else {
              args.push(
                '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
                '--merge-output-format', 'mp4'
              );
            }
          }

          const outName = `${itemIndexStr} - ${itemTitle}.%(ext)s`;
          args.push('-o', path.join(mediaDir, outName), item.url);

          sendItem('queued', 0);

          let settled = false;
          const finish = (error?: string) => {
            if (settled) return;
            settled = true;
            if (error) {
              sendItem('failed', undefined, error);
            } else {
              sendItem('done', 100);
            }
            resolve({ ok: !error });
          };

          try {
            const proc = spawn(YTDLP_PATH, args);

            let stdoutBuf = '';
            let lastSentPct = -1;
            proc.stdout.on('data', (d) => {
              stdoutBuf += d.toString();
              const lines = stdoutBuf.split(/\r?\n/);
              stdoutBuf = lines.pop() || '';

              for (const line of lines) {
                const pctMatch = line.match(/\[download\]\s+([\d.]+)%/);
                if (pctMatch) {
                  const pct = Math.floor(parseFloat(pctMatch[1]));
                  if (pct !== lastSentPct) {
                    lastSentPct = pct;
                    sendItem('downloading', pct);
                  }
                } else if (/\[(ExtractAudio|Merger|VideoConvertOrMux|FixupM4a)\]/.test(line)) {
                  // Download finished, ffmpeg post-processing (mp3 conversion / mp4 merge)
                  sendItem('processing', 100);
                }
              }
            });

            let errText = '';
            proc.stderr.on('data', (d) => { errText += d.toString(); });
            proc.on('error', (err) => finish(err.message || 'Failed to start yt-dlp'));
            proc.on('close', (code) => {
              if (code !== 0) {
                console.warn(`[Playlist Item Error] ${item.title}: ${errText}`);
                finish(`yt-dlp exited with code ${code}`);
              } else {
                finish();
              }
            });
          } catch (e: any) {
            console.warn(`Failed on item ${index}:`, e);
            finish(e?.message || 'Unexpected error');
          }
        });

        // Run downloads in parallel with a bounded worker pool: parallelism speeds
        // things up, while the cap keeps us under YouTube's rate limits.
        const MAX_PARALLEL = Math.min(4, items.length);
        const results: Array<{ ok: boolean } | undefined> = new Array(items.length);
        let nextIndex = 0;

        const worker = async () => {
          while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await downloadItem(items[i], i);
          }
        };

        await Promise.all(Array.from({ length: MAX_PARALLEL }, () => worker()));

        const failedCount = results.filter((r) => r && !r.ok).length;
        const succeededCount = items.length - failedCount;
        console.log(
          `[Playlist Download] Batch finished: ${succeededCount} succeeded, ${failedCount} failed`
        );

        // Remove any leftover thumbnails/metadata files so the zip only contains media
        try {
          for (const f of fs.readdirSync(mediaDir)) {
            if (!/\.(mp3|mp4|m4a|webm|mkv)$/i.test(f)) {
              fs.rmSync(path.join(mediaDir, f), { force: true });
            }
          }
        } catch {}

        // Verify downloaded files
        const downloadedFiles = fs.readdirSync(mediaDir);
        if (!downloadedFiles || downloadedFiles.length === 0) {
          send({ type: 'error', message: 'No playlist files were successfully downloaded.' });
          closed = true;
          try { controller.close(); } catch {}
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          return;
        }

        send({ type: 'phase', phase: 'zipping' });

        // Create a zip archive using Linux 'zip' utility
        const safeZipName = `${sanitizeFilename(playlistTitle || 'YouTube_Playlist')}_${isMp3Export ? 'MP3' : 'MP4'}.zip`;
        const asciiZipName = safeZipName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        const zipFilePath = path.join(sessionDir, safeZipName);

        const zipOk = await new Promise<boolean>((resolve) => {
          // Execute zip -r within sessionDir
          const zipProc = spawn('zip', ['-r', '-j', zipFilePath, mediaDir]);
          zipProc.on('close', (code) => resolve(code === 0));
          zipProc.on('error', () => resolve(false));
        });

        if (!zipOk || !fs.existsSync(zipFilePath)) {
          send({ type: 'error', message: 'Failed to package playlist into zip archive.' });
          closed = true;
          try { controller.close(); } catch {}
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          return;
        }

        // Keep the zip on disk so the client can pick it up via /api/playlist-file
        pendingZips.set(sessionId, {
          zipPath: zipFilePath,
          zipName: safeZipName,
          createdAt: Date.now(),
        });

        send({
          type: 'complete',
          sessionId,
          zipName: safeZipName,
          asciiZipName,
          zipSize: fs.statSync(zipFilePath).size,
          succeeded: succeededCount,
          failed: failedCount,
        });

        closed = true;
        try { controller.close(); } catch {}
      } catch (error: any) {
        console.error('Playlist export error:', error);
        send({ type: 'error', message: error?.message || 'Failed to export playlist. Please try again.' });
        closed = true;
        try { controller.close(); } catch {}
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
      }
    },
    cancel() {
      // Client aborted mid-stream: discard temp files and any pending registration
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
      pendingZips.delete(sessionId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
