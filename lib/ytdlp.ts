import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';

export const YTDLP_PATH = path.join(process.cwd(), 'bin', 'yt-dlp');
export const DOWNLOADS_TEMP_DIR = path.join(process.cwd(), '.temp_downloads');

if (!fs.existsSync(DOWNLOADS_TEMP_DIR)) {
  fs.mkdirSync(DOWNLOADS_TEMP_DIR, { recursive: true });
}

export interface FormatOption {
  format_id: string;
  ext: string;
  resolution?: string;
  height?: number;
  width?: number;
  fps?: number;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  vcodec?: string;
  acodec?: string;
  abr?: number;
  asr?: number;
  format_note?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  type: 'video' | 'audio' | 'video+audio';
  estimatedSizeFormatted: string;
  qualityLabel: string;
}

export interface VideoMetadata {
  id: string;
  title: string;
  description?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  duration_string?: string;
  thumbnail?: string;
  view_count?: number;
  formats: FormatOption[];
  rawUrl: string;
}

export interface PlaylistItemMetadata {
  id: string;
  title: string;
  duration?: number;
  duration_string?: string;
  thumbnail?: string;
  uploader?: string;
  url: string;
  estimatedMp3SizeFormatted?: string;
  estimatedVideoSizeFormatted?: string;
}

export interface PlaylistMetadata {
  isPlaylist: true;
  id: string;
  title: string;
  uploader?: string;
  itemCount: number;
  entries: PlaylistItemMetadata[];
  rawUrl: string;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec?: number): string {
  if (!sec || isNaN(sec)) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 150);
}
