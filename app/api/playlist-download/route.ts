import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { YTDLP_PATH, DOWNLOADS_TEMP_DIR, sanitizeFilename } from '@/lib/ytdlp';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const sessionId = `playlist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionDir = path.join(DOWNLOADS_TEMP_DIR, sessionId);
  const mediaDir = path.join(sessionDir, 'items');

  try {
    const { items, playlistTitle, format = 'mp3', quality } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items selected for download.' }, { status: 400 });
    }

    fs.mkdirSync(mediaDir, { recursive: true });

    const isMp3Export = format === 'mp3';
    console.log(`[Playlist Download] Starting batch of ${items.length} items (format: ${format})`);

    // Download a single item. Always resolves; failures are reported via the
    // returned result so one bad item never aborts the rest of the batch.
    const downloadItem = (item: any, index: number): Promise<{ ok: boolean; title: string; error?: string }> => {
      const itemIndexStr = String(index + 1).padStart(2, '0');
      const itemTitle = sanitizeFilename(item.title || `Track ${index + 1}`);

      const args = [
        '--js-runtimes', 'node',
        '--no-playlist',
        '--no-warnings',
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

      return new Promise((resolve) => {
        let settled = false;
        const finish = (error?: string) => {
          if (settled) return;
          settled = true;
          resolve({ ok: !error, title: item.title || `Track ${index + 1}`, error });
        };

        try {
          const proc = spawn(YTDLP_PATH, args);
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
    };

    // Run downloads in parallel with a bounded worker pool: parallelism speeds
    // things up, while the cap keeps us under YouTube's rate limits.
    const MAX_PARALLEL = Math.min(4, items.length);
    const results: Array<{ ok: boolean; title: string; error?: string }> = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await downloadItem(items[i], i);
      }
    };

    await Promise.all(Array.from({ length: MAX_PARALLEL }, () => worker()));

    const failed = results.filter((r) => r && !r.ok);
    console.log(
      `[Playlist Download] Batch finished: ${items.length - failed.length} succeeded, ${failed.length} failed` +
      (failed.length ? ` (${failed.map((f) => f.title).join(', ')})` : '')
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
      throw new Error('No playlist files were successfully downloaded.');
    }

    // Create a zip archive using Linux 'zip' utility
    const safeZipName = `${sanitizeFilename(playlistTitle || 'YouTube_Playlist')}_${isMp3Export ? 'MP3' : 'MP4'}.zip`;
    const asciiZipName = safeZipName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const zipFilePath = path.join(sessionDir, safeZipName);

    await new Promise<void>((resolve, reject) => {
      // Execute zip -r within sessionDir
      const zipProc = spawn('zip', ['-r', '-j', zipFilePath, mediaDir]);
      zipProc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Zip utility failed with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    if (!fs.existsSync(zipFilePath)) {
      throw new Error('Failed to package playlist into zip archive.');
    }

    const zipStats = fs.statSync(zipFilePath);
    const fileStream = fs.createReadStream(zipFilePath);

    fileStream.on('close', () => {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
    });

    const encodedZipName = encodeURIComponent(safeZipName);

    return new Response(fileStream as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': zipStats.size.toString(),
        'Content-Disposition': `attachment; filename="${asciiZipName}"; filename*=UTF-8''${encodedZipName}`,
        'Cache-Control': 'no-store',
      },
    });

  } catch (error: any) {
    console.error('Playlist export error:', error);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {}

    return NextResponse.json(
      { error: error.message || 'Failed to export playlist. Please try again.' },
      { status: 500 }
    );
  }
}
