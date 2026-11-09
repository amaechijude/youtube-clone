import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { YTDLP_PATH, DOWNLOADS_TEMP_DIR, sanitizeFilename } from '@/lib/ytdlp';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  const formatId = searchParams.get('formatId') || 'best-mp4';
  const convertMp3 = searchParams.get('convertMp3') === 'true' || formatId.startsWith('mp3');
  const quality = searchParams.get('quality'); // e.g. '1080', '720', '480', 'audio'
  const customTitle = searchParams.get('title');

  if (!url) {
    return NextResponse.json({ error: 'Missing media URL.' }, { status: 400 });
  }

  // Generate a unique session temp directory
  const downloadSessionId = `single_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionDir = path.join(DOWNLOADS_TEMP_DIR, downloadSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const isAudioOnly = convertMp3 || formatId.includes('mp3') || formatId.includes('m4a') || quality === 'audio';

    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '--no-warnings',
    ];

    let outputExtension = 'mp4';

    if (isAudioOnly) {
      outputExtension = 'mp3';
      args.push(
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', formatId.includes('high') ? '0' : '2',
        '-f', 'ba/b',
        '--embed-thumbnail',
        '--embed-metadata',
        '--convert-thumbnails', 'jpg'
      );
    } else {
      // Video mode
      outputExtension = 'mp4';
      if (quality && !isNaN(Number(quality))) {
        const heightNum = Number(quality);
        args.push(
          '-f', `bv*[height<=${heightNum}][ext=mp4]+ba[ext=m4a]/bv*[height<=${heightNum}]+ba/b[height<=${heightNum}]/b`,
          '--merge-output-format', 'mp4'
        );
      } else if (formatId.startsWith('res-')) {
        const heightNum = formatId.replace('res-', '');
        args.push(
          '-f', `bv*[height<=${heightNum}][ext=mp4]+ba[ext=m4a]/bv*[height<=${heightNum}]+ba/b[height<=${heightNum}]/b`,
          '--merge-output-format', 'mp4'
        );
      } else {
        // Best quality MP4
        args.push(
          '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
          '--merge-output-format', 'mp4'
        );
      }
    }

    const outputTemplate = path.join(sessionDir, '%(title)s.%(ext)s');
    args.push('-o', outputTemplate, url);

    console.log(`[Download] Starting: ${args.join(' ')}`);

    // Run process
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, args);

      let errOutput = '';
      proc.stderr.on('data', (d) => {
        errOutput += d.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(errOutput || `Download failed with exit code ${code}`));
        } else {
          resolve();
        }
      });
    });

    // Locate the downloaded file in sessionDir
    const files = fs.readdirSync(sessionDir);
    if (!files || files.length === 0) {
      throw new Error('Downloaded file was not created.');
    }

    // Pick the actual media file (not leftover thumbnails/metadata)
    const downloadedFileName =
      files.find((f) => f.toLowerCase().endsWith(`.${outputExtension}`)) ||
      files.find((f) => /\.(mp3|mp4|m4a|webm|mkv)$/i.test(f)) ||
      files[0];
    const fullFilePath = path.join(sessionDir, downloadedFileName);
    const stats = fs.statSync(fullFilePath);

    const safeDownloadName = sanitizeFilename(customTitle || downloadedFileName.replace(/\.[^/.]+$/, '')) + path.extname(downloadedFileName);
    const asciiDownloadName = safeDownloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

    // Stream file to response
    const fileStream = fs.createReadStream(fullFilePath);

    // Schedule cleanup after stream completes
    fileStream.on('close', () => {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to clean up download session directory:', e);
      }
    });

    // Build headers
    const contentType = isAudioOnly ? 'audio/mpeg' : 'video/mp4';
    const encodedFilename = encodeURIComponent(safeDownloadName);

    return new Response(fileStream as any, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stats.size.toString(),
        'Content-Disposition': `attachment; filename="${asciiDownloadName}"; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'no-store',
      },
    });

  } catch (err: any) {
    console.error('Download error:', err);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {}

    return NextResponse.json(
      { error: err.message || 'Download and conversion failed. Please try again.' },
      { status: 500 }
    );
  }
}
