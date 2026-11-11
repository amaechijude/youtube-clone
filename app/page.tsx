'use client';

import React, { useState } from 'react';
import { 
  Search, 
  PlaySquare, 
  Music, 
  Film, 
  Download, 
  FileAudio, 
  ListMusic, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Sparkles,
  ExternalLink,
  Layers,
  Clock,
  HardDrive,
  SlidersHorizontal,
  Check,
  ChevronDown
} from 'lucide-react';

interface FormatOption {
  format_id: string;
  ext: string;
  resolution?: string;
  height?: number;
  fps?: number;
  filesize_approx?: number;
  abr?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  type: 'video' | 'audio' | 'video+audio';
  estimatedSizeFormatted: string;
  qualityLabel: string;
}

interface SingleVideoResult {
  isPlaylist: false;
  id: string;
  title: string;
  uploader?: string;
  duration_string?: string;
  thumbnail?: string;
  view_count?: number;
  formats: FormatOption[];
  rawUrl: string;
}

interface PlaylistItem {
  id: string;
  title: string;
  duration_string?: string;
  thumbnail?: string;
  uploader?: string;
  url: string;
  estimatedMp3SizeFormatted: string;
  estimatedVideoSizeFormatted: string;
  estimatedMp3Bytes: number;
  estimatedVideoBytes: number;
}

interface PlaylistResult {
  isPlaylist: true;
  id: string;
  title: string;
  uploader?: string;
  itemCount: number;
  entries: PlaylistItem[];
  rawUrl: string;
}

type MediaResult = SingleVideoResult | PlaylistResult | null;

export default function HomePage() {
  const [inputUrl, setInputUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<MediaResult>(null);

  // Single video download options
  const [selectedFormatId, setSelectedFormatId] = useState<string>('best-mp4');
  const [activeDownloadKey, setActiveDownloadKey] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadStatusText, setDownloadStatusText] = useState<string>('');

  // Playlist options
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [playlistExportFormat, setPlaylistExportFormat] = useState<'mp3' | 'mp4'>('mp3');
  const [playlistQuality, setPlaylistQuality] = useState<string>('1080');
  const [isExportingPlaylist, setIsExportingPlaylist] = useState(false);
  // Live per-file progress during playlist export, keyed by the playlist row index.
  type ExportItemStatus = 'queued' | 'downloading' | 'processing' | 'done' | 'failed';
  const [exportItemProgress, setExportItemProgress] = useState<Record<number, { status: ExportItemStatus; percent: number }>>({});
  const [exportPhase, setExportPhase] = useState<'downloading' | 'zipping'>('downloading');

  // Handle URL analyze
  const handleAnalyze = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputUrl.trim()) return;

    setIsLoading(true);
    setErrorMsg(null);
    setResult(null);

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inputUrl.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch video/playlist information.');
      }

      setResult(data);

      if (data.isPlaylist) {
        // Select all items by default
        const initialMap: Record<string, boolean> = {};
        data.entries.forEach((item: PlaylistItem) => {
          initialMap[item.id] = true;
        });
        setSelectedItems(initialMap);
      } else {
        // Select best default format
        if (data.formats && data.formats.length > 0) {
          setSelectedFormatId(data.formats[0].format_id);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'An error occurred while fetching details.');
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger single item download with progress bar and loading feedback
  const handleSingleDownload = async (
    formatId: string, 
    customTitle?: string, 
    overrideUrl?: string, 
    downloadKey: string = 'main'
  ) => {
    if (activeDownloadKey) return; // Prevent concurrent single downloads

    const targetUrl = overrideUrl || (result as SingleVideoResult)?.rawUrl || inputUrl;
    const downloadUrl = `/api/download?url=${encodeURIComponent(targetUrl)}&formatId=${encodeURIComponent(formatId)}${customTitle ? `&title=${encodeURIComponent(customTitle)}` : ''}`;
    
    setActiveDownloadKey(downloadKey);
    setDownloadProgress(0);
    setDownloadStatusText('Processing & downloading media...');

    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        let errorMsg = 'Download failed';
        try {
          const errData = await response.json();
          errorMsg = errData.error || errorMsg;
        } catch {
          errorMsg = `Server returned ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMsg);
      }

      const contentLengthHeader = response.headers.get('Content-Length');
      const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

      // Extract filename from Content-Disposition if present
      let filename = customTitle ? `${customTitle}.${formatId.includes('mp3') ? 'mp3' : 'mp4'}` : 'download';
      const disposition = response.headers.get('Content-Disposition');
      if (disposition) {
        const utf8FilenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8FilenameMatch && utf8FilenameMatch[1]) {
          filename = decodeURIComponent(utf8FilenameMatch[1]);
        } else {
          const standardFilenameMatch = disposition.match(/filename="?([^";]+)"?/i);
          if (standardFilenameMatch && standardFilenameMatch[1]) {
            filename = standardFilenameMatch[1];
          }
        }
      }

      if (!response.body) {
        const blob = await response.blob();
        triggerBlobDownload(blob, filename);
        return;
      }

      // Stream the reader to calculate live progress
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          chunks.push(value);
          receivedBytes += value.length;

          if (totalBytes > 0) {
            const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            setDownloadProgress(pct);
            setDownloadStatusText(`Downloading: ${pct}% (${(receivedBytes / (1024 * 1024)).toFixed(1)} MB / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`);
          } else {
            setDownloadStatusText(`Downloading: ${(receivedBytes / (1024 * 1024)).toFixed(1)} MB transferred`);
          }
        }
      }

      setDownloadProgress(100);
      setDownloadStatusText('Saving file to your device...');

      const fullBlob = new Blob(chunks, {
        type: response.headers.get('Content-Type') || (formatId.includes('mp3') ? 'audio/mpeg' : 'video/mp4')
      });
      triggerBlobDownload(fullBlob, filename);
    } catch (err: any) {
      alert(`Download error: ${err.message || 'Failed to complete download.'}`);
    } finally {
      setTimeout(() => {
        setActiveDownloadKey(null);
        setDownloadProgress(null);
        setDownloadStatusText('');
      }, 1200);
    }
  };

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const blobUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => {
      window.URL.revokeObjectURL(blobUrl);
    }, 2000);
  };

  // Trigger playlist batch zip download with live per-file progress
  const handlePlaylistExport = async () => {
    if (!result || !result.isPlaylist) return;

    const chosenItems = result.entries.filter((item) => selectedItems[item.id]);
    if (chosenItems.length === 0) {
      alert('Please select at least one item from the playlist to download.');
      return;
    }

    setIsExportingPlaylist(true);
    setExportItemProgress({});
    setExportPhase('downloading');

    try {
      // Attach the original row index so progress events can be matched back
      // to the correct track in the UI.
      const payloadItems = result.entries
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => selectedItems[item.id])
        .map(({ item, index }) => ({ ...item, entryIndex: index }));

      const response = await fetch('/api/playlist-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playlistTitle: result.title,
          format: playlistExportFormat,
          quality: playlistQuality,
          items: payloadItems,
        }),
      });

      if (!response.ok) {
        let errorMsg = 'Failed to generate playlist package.';
        try {
          const errJson = await response.json();
          errorMsg = errJson.error || errorMsg;
        } catch {}
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('Streaming is not supported by this browser.');
      }

      // The server streams newline-delimited JSON progress events, one per
      // update, followed by a final "complete" or "error" event.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let zipSessionId: string | null = null;
      let zipName = '';

      const handleEvent = (evt: any) => {
        if (evt.type === 'item' && typeof evt.index === 'number') {
          setExportItemProgress((prev) => ({
            ...prev,
            [evt.index]: {
              status: evt.status || 'queued',
              percent: typeof evt.percent === 'number' ? evt.percent : 0,
            },
          }));
        } else if (evt.type === 'phase') {
          if (evt.phase === 'zipping') setExportPhase('zipping');
        } else if (evt.type === 'complete') {
          zipSessionId = evt.sessionId;
          zipName = evt.zipName || `${result!.title || 'Playlist'}_${playlistExportFormat.toUpperCase()}.zip`;
        } else if (evt.type === 'error') {
          throw new Error(evt.message || 'Playlist export failed.');
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(evt);
        }
      }
      if (buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer));
        } catch {}
      }

      if (!zipSessionId) {
        throw new Error('Export finished but no archive was produced.');
      }

      // Fetch the finished zip in a separate request
      const zipRes = await fetch(`/api/playlist-file?session=${encodeURIComponent(zipSessionId)}`);
      if (!zipRes.ok) {
        let errorMsg = 'Failed to download the ZIP archive.';
        try {
          const errJson = await zipRes.json();
          errorMsg = errJson.error || errorMsg;
        } catch {}
        throw new Error(errorMsg);
      }

      const blob = await zipRes.blob();
      triggerBlobDownload(blob, zipName);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    } finally {
      setIsExportingPlaylist(false);
      // Keep the per-file results visible briefly, then clear
      setTimeout(() => setExportItemProgress({}), 4000);
    }
  };

  // Calculate playlist selected items total size
  const calculatePlaylistTotalSize = () => {
    if (!result || !result.isPlaylist) return '0 MB';
    let totalBytes = 0;
    result.entries.forEach((item) => {
      if (selectedItems[item.id]) {
        totalBytes += playlistExportFormat === 'mp3' ? (item.estimatedMp3Bytes || 0) : (item.estimatedVideoBytes || 0);
      }
    });

    if (totalBytes === 0) return '0 MB';
    const mb = totalBytes / (1024 * 1024);
    if (mb > 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
  };

  const selectedCount = result && result.isPlaylist 
    ? Object.values(selectedItems).filter(Boolean).length 
    : 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-600 to-red-500 flex items-center justify-center shadow-lg shadow-rose-500/20">
              <PlaySquare className="w-6 h-6 text-white" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                YT Media<span className="text-rose-500">Hub</span>
              </span>
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium">
                Video & Audio MP3
              </span>
            </div>
          </div>
          
          <div className="flex items-center space-x-3 text-xs text-slate-400">
            <span className="flex items-center space-x-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span className="hidden sm:inline">Engine Ready (FFmpeg & yt-dlp)</span>
            </span>
          </div>
        </div>
      </header>

      {/* Hero & Search Input Section */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 flex flex-col items-center">
        <div className="text-center max-w-2xl mb-8">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            Download YouTube & Music In <span className="bg-gradient-to-r from-rose-500 to-amber-500 bg-clip-text text-transparent">Any Quality</span>
          </h1>
          <p className="text-slate-400 text-sm sm:text-base">
            Convert individual videos or whole playlists to high-fidelity MP3 or MP4 video with real-time size guides and quality controls.
          </p>
        </div>

        {/* Input Form */}
        <div className="w-full max-w-3xl mb-8">
          <form onSubmit={handleAnalyze} className="relative flex flex-col sm:flex-row gap-2 p-1.5 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl focus-within:border-rose-500/60 transition-all">
            <div className="flex-1 flex items-center px-4 space-x-3 min-h-[52px]">
              <Search className="w-5 h-5 text-slate-400 shrink-0" />
              <input
                type="text"
                placeholder="Paste YouTube video or playlist URL (e.g., https://www.youtube.com/watch?v=... or list=...)"
                className="w-full bg-transparent text-slate-100 placeholder-slate-500 focus:outline-none text-sm sm:text-base"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                disabled={isLoading}
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !inputUrl.trim()}
              className="px-6 py-3 rounded-xl bg-gradient-to-r from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 text-white font-medium text-sm flex items-center justify-center space-x-2 transition-all shadow-lg shadow-rose-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Inspecting...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Analyze</span>
                </>
              )}
            </button>
          </form>

          {/* Quick preset hints */}
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3 text-xs text-slate-500">
            <span>Supports:</span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">Single Videos</span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">YouTube Music</span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">Full Playlists</span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">320kbps MP3</span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">1080p / 4K MP4</span>
          </div>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="w-full max-w-3xl mb-8 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start space-x-3 text-rose-300 text-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-400" />
            <div className="flex-1">
              <span className="font-semibold block mb-0.5">Could not load media</span>
              <span>{errorMsg}</span>
            </div>
          </div>
        )}

        {/* Result Area */}
        {result && (
          <div className="w-full max-w-4xl space-y-6 animate-in fade-in slide-in-from-bottom-3 duration-300">
            {/* If Single Video */}
            {!result.isPlaylist && (() => {
              const video = result as SingleVideoResult;
              return (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
                {/* Video Info Header Card */}
                <div className="p-5 sm:p-6 flex flex-col md:flex-row gap-6 items-start border-b border-slate-800/80 bg-gradient-to-b from-slate-800/30 to-transparent">
                  {video.thumbnail && (
                    <div className="relative w-full md:w-64 aspect-video rounded-xl overflow-hidden bg-slate-950 shrink-0 border border-slate-800 shadow-md">
                      <img 
                        src={video.thumbnail} 
                        alt={video.title} 
                        className="w-full h-full object-cover" 
                      />
                      <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-black/80 backdrop-blur-sm rounded text-[11px] font-semibold tracking-wide text-slate-200">
                        {video.duration_string || '--:--'}
                      </div>
                    </div>
                  )}

                  <div className="flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center space-x-2 mb-2">
                        <span className="px-2 py-0.5 text-[11px] font-semibold uppercase rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                          Single Media
                        </span>
                        <span className="text-xs text-slate-400 flex items-center">
                          <Clock className="w-3.5 h-3.5 mr-1" />
                          {video.duration_string}
                        </span>
                      </div>

                      <h2 className="text-xl sm:text-2xl font-bold text-slate-100 tracking-tight leading-snug mb-2">
                        {video.title}
                      </h2>
                      <p className="text-sm text-slate-400 mb-4">
                        Channel / Artist: <span className="text-slate-200 font-medium">{video.uploader}</span>
                      </p>
                    </div>

                    {/* Quick MP3 One-Click Convert */}
                    <div className="flex flex-wrap items-center gap-3 pt-2">
                      <button
                        disabled={!!activeDownloadKey}
                        onClick={() => handleSingleDownload('mp3-high', video.title, undefined, 'quick-mp3')}
                        className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center space-x-2 shadow-lg shadow-emerald-600/20 transition-all"
                      >
                        {activeDownloadKey === 'quick-mp3' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <FileAudio className="w-4 h-4" />
                        )}
                        <span>
                          {activeDownloadKey === 'quick-mp3' ? 'Processing MP3...' : 'Quick Convert to MP3 (320kbps)'}
                        </span>
                      </button>

                      <button
                        disabled={!!activeDownloadKey}
                        onClick={() => handleSingleDownload('best-mp4', video.title, undefined, 'quick-mp4')}
                        className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center space-x-2 shadow-lg shadow-rose-600/20 transition-all"
                      >
                        {activeDownloadKey === 'quick-mp4' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Film className="w-4 h-4" />
                        )}
                        <span>
                          {activeDownloadKey === 'quick-mp4' ? 'Processing MP4...' : 'Best Video (MP4)'}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Quality & Size Selector Table */}
                <div className="p-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-base text-slate-200 flex items-center space-x-2">
                      <SlidersHorizontal className="w-4 h-4 text-rose-400" />
                      <span>Select Specific Quality & Estimated File Size</span>
                    </h3>
                    <span className="text-xs text-slate-400">Total size guided by format bitrate</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {video.formats.map((fmt) => {
                      const isSelected = selectedFormatId === fmt.format_id;
                      const isAudio = fmt.type === 'audio';

                      return (
                        <div
                          key={fmt.format_id}
                          onClick={() => setSelectedFormatId(fmt.format_id)}
                          className={`cursor-pointer p-4 rounded-xl border transition-all flex items-center justify-between ${
                            isSelected
                              ? 'bg-rose-500/10 border-rose-500 ring-1 ring-rose-500/30'
                              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                          }`}
                        >
                          <div className="flex items-center space-x-3">
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                              isAudio ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-400'
                            }`}>
                              {isAudio ? <FileAudio className="w-5 h-5" /> : <Film className="w-5 h-5" />}
                            </div>

                            <div>
                              <div className="font-medium text-sm text-slate-100 flex items-center space-x-1.5">
                                <span>{fmt.qualityLabel}</span>
                                {fmt.ext && (
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 uppercase font-mono">
                                    {fmt.ext}
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-slate-400">
                                {isAudio ? 'Audio format' : 'Video format'}
                              </span>
                            </div>
                          </div>

                          {/* File size guide pill */}
                          <div className="text-right pl-3 shrink-0">
                            <div className="flex items-center space-x-1 text-slate-300 font-semibold text-sm">
                              <HardDrive className="w-3.5 h-3.5 text-slate-400" />
                              <span>{fmt.estimatedSizeFormatted}</span>
                            </div>
                            <span className="text-[10px] text-slate-500">approx size</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Bottom Download Action */}
                  <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col gap-4">
                    {/* Progress bar when downloading main format */}
                    {activeDownloadKey === 'selected-format' && (
                      <div className="w-full bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col gap-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-300 font-medium flex items-center space-x-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500" />
                            <span>{downloadStatusText || 'Downloading media...'}</span>
                          </span>
                          {downloadProgress !== null && (
                            <span className="text-rose-400 font-mono font-semibold">{downloadProgress}%</span>
                          )}
                        </div>
                        <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                          {downloadProgress !== null ? (
                            <div 
                              className="bg-gradient-to-r from-rose-500 to-amber-500 h-full transition-all duration-200 ease-out"
                              style={{ width: `${downloadProgress}%` }}
                            />
                          ) : (
                            <div className="bg-gradient-to-r from-rose-500 to-amber-500 h-full w-2/3 animate-pulse" />
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                      <div className="text-xs text-slate-400">
                        Selected: <span className="text-slate-200 font-medium">
                          {video.formats.find(f => f.format_id === selectedFormatId)?.qualityLabel || 'Default'}
                        </span>
                        {' '}&bull;{' '}
                        Size Guide: <span className="text-emerald-400 font-medium">
                          {video.formats.find(f => f.format_id === selectedFormatId)?.estimatedSizeFormatted || 'Variable'}
                        </span>
                      </div>

                      <button
                        disabled={!!activeDownloadKey}
                        onClick={() => handleSingleDownload(selectedFormatId, video.title, undefined, 'selected-format')}
                        className="w-full sm:w-auto px-8 py-3 rounded-xl bg-gradient-to-r from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm flex items-center justify-center space-x-2 transition-all shadow-lg shadow-rose-600/30"
                      >
                        {activeDownloadKey === 'selected-format' ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Processing & Downloading...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            <span>Download Selected Format</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* If Playlist Result */}
            {result.isPlaylist && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
                {/* Playlist Info Header */}
                <div className="p-6 border-b border-slate-800 bg-gradient-to-b from-slate-800/40 to-transparent">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                      <div className="flex items-center space-x-2 mb-2">
                        <span className="px-2.5 py-0.5 text-xs font-semibold uppercase rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center space-x-1">
                          <ListMusic className="w-3.5 h-3.5 mr-1" />
                          <span>YouTube Playlist</span>
                        </span>
                        <span className="text-xs text-slate-400">
                          {result.itemCount} items found
                        </span>
                      </div>

                      <h2 className="text-2xl font-bold text-slate-100 tracking-tight">
                        {result.title}
                      </h2>
                      <p className="text-sm text-slate-400 mt-1">
                        Curated by: <span className="text-slate-200 font-medium">{result.uploader}</span>
                      </p>
                    </div>

                    {/* Quick batch selection stats */}
                    <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 text-right w-full md:w-auto">
                      <div className="text-xs text-slate-400 mb-1">Total Estimated Batch Size:</div>
                      <div className="text-xl font-bold text-emerald-400 flex items-center justify-end space-x-1.5">
                        <HardDrive className="w-4 h-4 text-emerald-500" />
                        <span>{calculatePlaylistTotalSize()}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {selectedCount} of {result.itemCount} selected
                      </div>
                    </div>
                  </div>

                  {/* Playlist Controls & Format Switcher */}
                  <div className="mt-6 pt-5 border-t border-slate-800/70 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center space-x-4">
                      {/* Format toggle: MP3 or MP4 */}
                      <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
                        <button
                          onClick={() => setPlaylistExportFormat('mp3')}
                          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                            playlistExportFormat === 'mp3'
                              ? 'bg-rose-600 text-white shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <FileAudio className="w-3.5 h-3.5" />
                          <span>Convert All to MP3 (Audio)</span>
                        </button>
                        <button
                          onClick={() => setPlaylistExportFormat('mp4')}
                          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                            playlistExportFormat === 'mp4'
                              ? 'bg-rose-600 text-white shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <Film className="w-3.5 h-3.5" />
                          <span>Download as Video (MP4)</span>
                        </button>
                      </div>

                      {/* Video resolution selector if MP4 */}
                      {playlistExportFormat === 'mp4' && (
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-slate-400">Quality:</span>
                          <select
                            value={playlistQuality}
                            onChange={(e) => setPlaylistQuality(e.target.value)}
                            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none"
                          >
                            <option value="1080">1080p Full HD</option>
                            <option value="720">720p HD</option>
                            <option value="480">480p Standard</option>
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Batch Actions */}
                    <div className="flex items-center space-x-3 w-full sm:w-auto">
                      <button
                        onClick={() => {
                          const allTrue: Record<string, boolean> = {};
                          result.entries.forEach(item => { allTrue[item.id] = true; });
                          setSelectedItems(allTrue);
                        }}
                        className="text-xs text-slate-400 hover:text-slate-200 underline"
                      >
                        Select All
                      </button>
                      <span className="text-slate-700">|</span>
                      <button
                        onClick={() => setSelectedItems({})}
                        className="text-xs text-slate-400 hover:text-slate-200 underline"
                      >
                        Deselect All
                      </button>

                      <button
                        onClick={handlePlaylistExport}
                        disabled={isExportingPlaylist || selectedCount === 0}
                        className="ml-auto px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-medium text-xs flex items-center space-x-2 shadow-lg shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        {isExportingPlaylist ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>
                              {exportPhase === 'zipping'
                                ? 'Packaging ZIP archive...'
                                : (() => {
                                    const statuses = Object.values(exportItemProgress);
                                    const finished = statuses.filter(p => p.status === 'done' || p.status === 'failed').length;
                                    return `Downloading ${finished}/${statuses.length || selectedCount} files...`;
                                  })()}
                            </span>
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            <span>Export Playlist ({playlistExportFormat.toUpperCase()} ZIP)</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Playlist Tracks Table */}
                <div className="divide-y divide-slate-800/80 max-h-[550px] overflow-y-auto">
                  {result.entries.map((item, index) => {
                    const isChecked = !!selectedItems[item.id];
                    const itemSize = playlistExportFormat === 'mp3' 
                      ? item.estimatedMp3SizeFormatted 
                      : item.estimatedVideoSizeFormatted;

                    return (
                      <div
                        key={item.id}
                        className={`p-3.5 sm:p-4 flex items-center justify-between gap-3 transition-colors ${
                          isChecked ? 'bg-slate-900/60' : 'bg-slate-950/40 opacity-70'
                        } hover:bg-slate-850`}
                      >
                        {/* Checkbox and index */}
                        <div className="flex items-center space-x-3">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              setSelectedItems(prev => ({
                                ...prev,
                                [item.id]: e.target.checked,
                              }));
                            }}
                            className="w-4 h-4 rounded border-slate-700 text-rose-600 focus:ring-rose-500/30 bg-slate-950 cursor-pointer"
                          />
                          <span className="text-xs font-mono text-slate-500 w-5 text-right">
                            {index + 1}
                          </span>
                        </div>

                        {/* Thumbnail */}
                        {item.thumbnail && (
                          <div className="w-16 h-10 rounded-md overflow-hidden bg-slate-950 shrink-0 border border-slate-800">
                            <img src={item.thumbnail} alt={item.title} className="w-full h-full object-cover" />
                          </div>
                        )}

                        {/* Track Info */}
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-medium text-slate-200 truncate">
                            {item.title}
                          </h4>
                          <div className="flex items-center space-x-3 text-xs text-slate-500 mt-0.5">
                            <span>{item.uploader}</span>
                            <span>&bull;</span>
                            <span className="flex items-center">
                              <Clock className="w-3 h-3 mr-1" />
                              {item.duration_string}
                            </span>
                          </div>

                          {/* Live per-file download progress during playlist export */}
                          {isExportingPlaylist && isChecked && exportItemProgress[index] && (() => {
                            const p = exportItemProgress[index];
                            const pct = p.status === 'done' || p.status === 'failed' ? 100 : (p.percent || 0);
                            const isDone = p.status === 'done';
                            const isFailed = p.status === 'failed';
                            const label =
                              p.status === 'queued' ? 'Queued...'
                              : p.status === 'downloading' ? `Downloading ${pct}%`
                              : p.status === 'processing' ? 'Converting...'
                              : isDone ? 'Done'
                              : 'Failed';
                            return (
                              <div className="mt-1.5 flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full transition-all duration-200 ease-out ${
                                      isFailed
                                        ? 'bg-rose-500'
                                        : isDone
                                        ? 'bg-emerald-500'
                                        : 'bg-gradient-to-r from-rose-500 to-amber-500'
                                    }`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span
                                  className={`text-[10px] font-mono shrink-0 ${
                                    isFailed ? 'text-rose-400' : isDone ? 'text-emerald-400' : 'text-rose-300'
                                  }`}
                                >
                                  {label}
                                </span>
                              </div>
                            );
                          })()}
                        </div>

                        {/* Size guide badge */}
                        <div className="text-right shrink-0 px-2">
                          <span className="text-xs font-semibold text-slate-300 block">
                            {itemSize}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            {playlistExportFormat.toUpperCase()} guide
                          </span>
                        </div>

                        {/* Individual track direct download button */}
                        <div className="flex items-center space-x-1.5 shrink-0">
                          <button
                            disabled={!!activeDownloadKey}
                            title="Download single track as MP3"
                            onClick={() => handleSingleDownload('mp3-high', item.title, item.url, `track-mp3-${item.id}`)}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-300 hover:text-white transition-all text-xs"
                          >
                            {activeDownloadKey === `track-mp3-${item.id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                            ) : (
                              <FileAudio className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            disabled={!!activeDownloadKey}
                            title="Download single track as MP4"
                            onClick={() => handleSingleDownload('best-mp4', item.title, item.url, `track-mp4-${item.id}`)}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-300 hover:text-white transition-all text-xs"
                          >
                            {activeDownloadKey === `track-mp4-${item.id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                            ) : (
                              <Film className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Features Info Cards */}
        {!result && !isLoading && (
          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-5 mt-4">
            <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center mb-4">
                <FileAudio className="w-5 h-5" />
              </div>
              <h3 className="font-semibold text-slate-200 mb-1">High-Fidelity MP3</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Extract pristine audio from YouTube videos or YouTube Music tracks up to 320 kbps bitrates with integrated FFmpeg encoding.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
              <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center mb-4">
                <ListMusic className="w-5 h-5" />
              </div>
              <h3 className="font-semibold text-slate-200 mb-1">Playlist to MP3 / ZIP</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Paste any public YouTube playlist to inspect all tracks, customize selection, and export entire album batches packaged into ZIP.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4">
                <HardDrive className="w-5 h-5" />
              </div>
              <h3 className="font-semibold text-slate-200 mb-1">Live Size Guide</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Real-time estimated file sizes for every quality tier and track before downloading, keeping your storage in check.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <p>Built with Next.js, Tailwind CSS, FFmpeg, and yt-dlp.</p>
      </footer>
    </div>
  );
}
