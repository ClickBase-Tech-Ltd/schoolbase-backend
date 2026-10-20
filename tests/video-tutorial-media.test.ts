import assert from 'node:assert/strict';
import test from 'node:test';
import { isSelfHostedVideoUrl, normalizeYouTubeVideoUrl, VIDEO_TUTORIAL_MEDIA_PREFIX } from '../src/services/video-tutorial-media.js';

test('recognizes only generated legacy SchoolBase tutorial media paths', () => {
  assert.equal(isSelfHostedVideoUrl(`${VIDEO_TUTORIAL_MEDIA_PREFIX}01234567-89ab-cdef-0123-456789abcdef.mp4`), true);
  assert.equal(isSelfHostedVideoUrl('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(isSelfHostedVideoUrl('https://www.loom.com/share/abc'), false);
  assert.equal(isSelfHostedVideoUrl(`${VIDEO_TUTORIAL_MEDIA_PREFIX}../private.mp4`), false);
  assert.equal(isSelfHostedVideoUrl('/uploads/other/01234567-89ab-cdef-0123-456789abcdef.mp4'), false);
});

test('normalizes supported YouTube links to canonical watch URLs', () => {
  assert.equal(normalizeYouTubeVideoUrl('https://www.youtube.com/watch?v=abcdefghijk&t=25'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(normalizeYouTubeVideoUrl('https://youtu.be/abcdefghijk?si=example'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(normalizeYouTubeVideoUrl('https://youtube.com/shorts/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(normalizeYouTubeVideoUrl('https://youtube.com/embed/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('rejects non-YouTube, malformed, and insecure media links', () => {
  assert.equal(normalizeYouTubeVideoUrl('https://example.com/watch?v=abcdefghijk'), null);
  assert.equal(normalizeYouTubeVideoUrl('http://youtube.com/watch?v=abcdefghijk'), null);
  assert.equal(normalizeYouTubeVideoUrl('https://youtube.com/watch?v=short'), null);
  assert.equal(normalizeYouTubeVideoUrl('javascript:alert(1)'), null);
  assert.equal(normalizeYouTubeVideoUrl(null), null);
});