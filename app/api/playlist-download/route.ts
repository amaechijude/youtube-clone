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

    // Download items sequentially or in batches of 2 to avoid YouTube rate limits
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemIndexStr = String(i + 1).padStart(2, '0');
      const itemTitle = sanitizeFilename(item.title || `Track ${i + 1}`);

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
          '-f', 'ba/b'
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

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(YTDLP_PATH, args);
          let errText = '';
          proc.stderr.on('data', (d) => { errText += d.toString(); });
          proc.on('close', (code) => {
            if (code !== 0) {
              console.warn(`[Playlist Item Error] ${item.title}: ${errText}`);
            }
            // Continue even if one fails
            resolve();
          });
        });
      } catch (e) {
        console.warn(`Failed on item ${i}:`, e);
      }
    }

    // Verify downloaded files
    const downloadedFiles = fs.readdirSync(mediaDir);
    if (!downloadedFiles || downloadedFiles.length === 0) {
      throw new Error('No playlist files were successfully downloaded.');
    }

    // Create a zip archive using Linux 'zip' utility
    const safeZipName = `${sanitizeFilename(playlistTitle || 'YouTube_Playlist')}_${isMp3Export ? 'MP3' : 'MP4'}.zip`;
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
        'Content-Disposition': `attachment; filename="${safeZipName}"; filename*=UTF-8''${encodedZipName}`,
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
