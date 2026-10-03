import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStreamManifest } from '../src/stream-manifest.js';

test('upstream HLS parser preserves bounded clear segments and rejects keys', async () => {
  const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST\n';
  const parsed = await parseStreamManifest(text, 'https://example.test/audio/list.m3u8', new AbortController().signal);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0]?.uri, 'https://example.test/audio/a.ts');
  await assert.rejects(() => parseStreamManifest(text.replace('#EXTINF:2,', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,'),
    'https://example.test/audio/list.m3u8', new AbortController().signal), /UNSUPPORTED_MEDIA/);
});

test('upstream DASH parser resolves an unencrypted audio representation without fetching URLs', async () => {
  const text = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S">'
    + '<Period><AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en"><Representation id="a" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000">'
    + '<SegmentTemplate timescale="1" duration="2" startNumber="1" media="audio-$Number$.m4s" initialization="init.mp4"/>'
    + '</Representation></AdaptationSet></Period></MPD>';
  const parsed = await parseStreamManifest(text, 'https://example.test/dash/manifest.mpd', new AbortController().signal);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.segments[0]?.uri, 'https://example.test/dash/audio-1.m4s');
  assert.equal(parsed.segments[0]?.map?.uri, 'https://example.test/dash/init.mp4');
});
