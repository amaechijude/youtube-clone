import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { YTDLP_PATH, formatBytes, formatDuration, FormatOption } from '@/lib/ytdlp';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube or YouTube Music URL.' }, { status: 400 });
    }

    const trimmedUrl = url.trim();

    // Run yt-dlp to inspect url
    // If it's a playlist or video, flat-playlist first or full dump
    const isPlaylistCandidate = trimmedUrl.includes('list=') || trimmedUrl.includes('/playlist');

    if (isPlaylistCandidate) {
      // Check playlist info
      const playlistData = await extractPlaylistInfo(trimmedUrl);
      if (playlistData) {
        return NextResponse.json(playlistData);
      }
    }

    // Otherwise, single video extraction
    const videoData = await extractVideoInfo(trimmedUrl);
    return NextResponse.json(videoData);

  } catch (error: any) {
    console.error('Info extraction error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch media details from YouTube. Please check the URL and try again.' },
      { status: 500 }
    );
  }
}

async function extractVideoInfo(url: string) {
  return new Promise((resolve, reject) => {
    const args = [
      '--js-runtimes', 'node',
      '--dump-single-json',
      '--no-playlist',
      '--skip-download',
      url,
    ];

    const proc = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || 'yt-dlp failed to process the video URL.'));
      }

      try {
        const json = JSON.parse(stdout);
        const duration = json.duration || 0;

        // Process audio formats
        const audioFormats: FormatOption[] = [];
        const videoFormats: FormatOption[] = [];

        // Add standard MP3 preset option
        const bestAudioBitrate = 192; // 192kbps typical
        const approxAudioBytes = duration > 0 ? (bestAudioBitrate * 1000 / 8) * duration : undefined;

        audioFormats.push({
          format_id: 'mp3-high',
          ext: 'mp3',
          format_note: 'HQ MP3 320kbps (Converted)',
          abr: 320,
          hasVideo: false,
          hasAudio: true,
          type: 'audio',
          filesize_approx: duration > 0 ? (320 * 1000 / 8) * duration : undefined,
          estimatedSizeFormatted: formatBytes(duration > 0 ? (320 * 1000 / 8) * duration : undefined),
          qualityLabel: 'MP3 High Quality (320 kbps)',
        });

        audioFormats.push({
          format_id: 'mp3-standard',
          ext: 'mp3',
          format_note: 'MP3 192kbps (Standard)',
          abr: 192,
          hasVideo: false,
          hasAudio: true,
          type: 'audio',
          filesize_approx: approxAudioBytes,
          estimatedSizeFormatted: formatBytes(approxAudioBytes),
          qualityLabel: 'MP3 Standard (192 kbps)',
        });

        audioFormats.push({
          format_id: 'm4a-best',
          ext: 'm4a',
          format_note: 'M4A / AAC Best Native',
          abr: 160,
          hasVideo: false,
          hasAudio: true,
          type: 'audio',
          filesize_approx: duration > 0 ? (160 * 1000 / 8) * duration : undefined,
          estimatedSizeFormatted: formatBytes(duration > 0 ? (160 * 1000 / 8) * duration : undefined),
          qualityLabel: 'M4A Audio (Native AAC)',
        });

        // Filter video formats
        const rawFormats: any[] = json.formats || [];
        
        // Group available heights
        const targetResolutions = [2160, 1440, 1080, 720, 480, 360];
        
        for (const res of targetResolutions) {
          // Find video format with this height
          const vFormat = rawFormats.find((f) => f.height === res && f.vcodec && f.vcodec !== 'none');
          if (vFormat) {
            let totalBytes = vFormat.filesize || vFormat.filesize_approx;
            if (!totalBytes && vFormat.tbr && duration > 0) {
              totalBytes = (vFormat.tbr * 1000 / 8) * duration;
            } else if (!totalBytes && approxAudioBytes) {
              // rough estimation for video resolution
              const bitrateEstKbps = res >= 2160 ? 15000 : res >= 1440 ? 8000 : res >= 1080 ? 4000 : res >= 720 ? 2200 : res >= 480 ? 1000 : 600;
              totalBytes = duration > 0 ? (bitrateEstKbps * 1000 / 8) * duration : undefined;
            }

            videoFormats.push({
              format_id: `res-${res}`,
              ext: 'mp4',
              height: res,
              resolution: `${res}p`,
              fps: vFormat.fps,
              vcodec: vFormat.vcodec,
              hasVideo: true,
              hasAudio: true,
              type: 'video',
              filesize_approx: totalBytes,
              estimatedSizeFormatted: formatBytes(totalBytes),
              qualityLabel: `MP4 Video ${res}p ${vFormat.fps ? `${vFormat.fps}fps` : ''}`,
            });
          }
        }

        // Always ensure at least Best Video MP4 exists
        videoFormats.unshift({
          format_id: 'best-mp4',
          ext: 'mp4',
          resolution: 'Best Available',
          hasVideo: true,
          hasAudio: true,
          type: 'video',
          filesize_approx: videoFormats[0]?.filesize_approx,
          estimatedSizeFormatted: videoFormats[0]?.estimatedSizeFormatted || 'Variable',
          qualityLabel: 'Best Quality Video (MP4)',
        });

        const result = {
          isPlaylist: false,
          id: json.id,
          title: json.title,
          description: json.description ? json.description.slice(0, 300) : '',
          uploader: json.uploader || json.channel || 'YouTube Creator',
          channel: json.channel,
          duration,
          duration_string: formatDuration(duration),
          thumbnail: json.thumbnail,
          view_count: json.view_count,
          formats: [...videoFormats, ...audioFormats],
          rawUrl: url,
        };

        resolve(result);
      } catch (e: any) {
        reject(new Error(`Failed to parse video metadata: ${e.message}`));
      }
    });
  });
}

async function extractPlaylistInfo(url: string) {
  return new Promise((resolve, reject) => {
    const args = [
      '--js-runtimes', 'node',
      '--dump-single-json',
      '--flat-playlist',
      '--skip-download',
      url,
    ];

    const proc = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        // Fallback to single video if playlist flag failed or not a real playlist
        return resolve(null);
      }

      try {
        const json = JSON.parse(stdout);
        if (!json.entries || !Array.isArray(json.entries) || json.entries.length === 0) {
          return resolve(null);
        }

        const entries = json.entries.map((item: any, idx: number) => {
          const dur = item.duration || 0;
          const approxMp3Bytes = dur > 0 ? (256 * 1000 / 8) * dur : undefined;
          const approxVidBytes = dur > 0 ? (2500 * 1000 / 8) * dur : undefined;

          return {
            id: item.id || `track-${idx}`,
            title: item.title || `Track ${idx + 1}`,
            duration: dur,
            duration_string: formatDuration(dur),
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
            uploader: item.uploader || item.channel || json.title,
            url: item.url ? (item.url.startsWith('http') ? item.url : `https://www.youtube.com/watch?v=${item.id}`) : `https://www.youtube.com/watch?v=${item.id}`,
            estimatedMp3SizeFormatted: formatBytes(approxMp3Bytes),
            estimatedVideoSizeFormatted: formatBytes(approxVidBytes),
            estimatedMp3Bytes: approxMp3Bytes || 0,
            estimatedVideoBytes: approxVidBytes || 0,
          };
        });

        resolve({
          isPlaylist: true,
          id: json.id || 'playlist',
          title: json.title || 'YouTube Playlist',
          uploader: json.uploader || json.channel || 'YouTube',
          itemCount: entries.length,
          entries,
          rawUrl: url,
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
}
