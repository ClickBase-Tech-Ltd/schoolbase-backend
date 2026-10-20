import { unlink } from 'node:fs/promises';
import path from 'node:path';

export const VIDEO_TUTORIAL_MEDIA_PREFIX = '/uploads/video-tutorials/';

const videoDirectory = path.resolve(process.cwd(), 'uploads/video-tutorials');

const youtubeVideoIdPattern = /^[a-zA-Z0-9_-]{11}$/;

export function normalizeYouTubeVideoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  let videoId = '';
  if (hostname === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  } else if (hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v') || '';
    } else if (/^\/(embed|shorts|live)\//.test(url.pathname)) {
      videoId = url.pathname.split('/')[2] || '';
    }
  }

  return youtubeVideoIdPattern.test(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
}

export function isSelfHostedVideoUrl(value: string): boolean {
  return value.startsWith(VIDEO_TUTORIAL_MEDIA_PREFIX)
    && /^[a-f0-9-]{36}\.mp4$/i.test(value.slice(VIDEO_TUTORIAL_MEDIA_PREFIX.length));
}

export function isPublicTutorialVideoUrl(value: string): boolean {
  if (isSelfHostedVideoUrl(value) || normalizeYouTubeVideoUrl(value) !== null) return true;

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase().replace(/^www\./, '') === 'loom.com'
      && /^\/share\/[a-zA-Z0-9]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function removeSelfHostedVideoFile(value: string): Promise<void> {
  if (!isSelfHostedVideoUrl(value)) return;
  const filePath = path.join(videoDirectory, path.basename(value));
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}