import { randomUUID } from 'node:crypto';
import { open, mkdir, unlink } from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';

export const VIDEO_TUTORIAL_MEDIA_PREFIX = '/uploads/video-tutorials/';
export const MAX_VIDEO_TUTORIAL_BYTES = 500 * 1024 * 1024;

const videoDirectory = path.resolve(process.cwd(), 'uploads/video-tutorials');

export const videoTutorialUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      void mkdir(videoDirectory, { recursive: true })
        .then(() => callback(null, videoDirectory))
        .catch((error: Error) => callback(error, videoDirectory));
    },
    filename: (_request, _file, callback) => callback(null, `${randomUUID()}.mp4`),
  }),
  limits: { fileSize: MAX_VIDEO_TUTORIAL_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.mp4' || file.mimetype !== 'video/mp4') {
      callback(new Error('Upload an MP4 video file.'));
      return;
    }
    callback(null, true);
  },
});

export function isSelfHostedVideoUrl(value: string): boolean {
  return value.startsWith(VIDEO_TUTORIAL_MEDIA_PREFIX)
    && /^[a-f0-9-]{36}\.mp4$/i.test(value.slice(VIDEO_TUTORIAL_MEDIA_PREFIX.length));
}

export async function hasMp4FileSignature(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('ascii', 4, 8) === 'ftyp';
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
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

export async function removeUploadedVideoFile(filePath: string): Promise<void> {
  if (path.dirname(path.resolve(filePath)) !== videoDirectory) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}