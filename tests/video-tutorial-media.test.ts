import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasMp4FileSignature, isSelfHostedVideoUrl, VIDEO_TUTORIAL_MEDIA_PREFIX } from '../src/services/video-tutorial-media.js';

test('recognizes only generated SchoolBase tutorial media paths', () => {
  assert.equal(isSelfHostedVideoUrl(`${VIDEO_TUTORIAL_MEDIA_PREFIX}01234567-89ab-cdef-0123-456789abcdef.mp4`), true);
  assert.equal(isSelfHostedVideoUrl('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(isSelfHostedVideoUrl('https://www.loom.com/share/abc'), false);
  assert.equal(isSelfHostedVideoUrl(`${VIDEO_TUTORIAL_MEDIA_PREFIX}../private.mp4`), false);
  assert.equal(isSelfHostedVideoUrl('/uploads/other/01234567-89ab-cdef-0123-456789abcdef.mp4'), false);
});

test('checks the MP4 container signature without reading the whole file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'schoolbase-video-test-'));
  const mp4Path = path.join(directory, 'sample.mp4');
  const wrongPath = path.join(directory, 'sample.txt');
  try {
    await writeFile(mp4Path, Buffer.from('0000ftypisom0000'));
    await writeFile(wrongPath, Buffer.from('not an mp4 file'));
    assert.equal(await hasMp4FileSignature(mp4Path), true);
    assert.equal(await hasMp4FileSignature(wrongPath), false);
    assert.equal(await hasMp4FileSignature(path.join(directory, 'missing.mp4')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});