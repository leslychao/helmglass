"""Bounded decoding, timeline ownership and resumable result production."""
from collections import deque
import json
import math
import os
from pathlib import Path
import resource
import select
import subprocess
import time
import urllib.parse
import urllib.request

import numpy as np
import parselmouth
import torch

RATE = 16000
CORE = 16 * RATE
CONTEXT = 2 * RATE
LIMIT = 20 * RATE


class ProcessingError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def sec(sample):
    return round(sample / RATE, 6)


def intervals(start, end, speech):
    """Partition the whole interval, including initial and trailing silence."""
    result = []
    cursor = start
    for left, right in speech:
        left, right = max(start, left), min(end, right)
        if right <= cursor:
            continue
        left = max(cursor, left)
        if left > cursor:
            result.append({'start': sec(cursor), 'end': sec(left), 'kind': 'pause'})
        if right > left:
            result.append({'start': sec(left), 'end': sec(right), 'kind': 'speech'})
        cursor = right
    if cursor < end:
        result.append({'start': sec(cursor), 'end': sec(end), 'kind': 'pause'})
    return result


def choose_end(start, end, spans, final):
    if final or end - start < CORE:
        return end
    pauses = [p for p in spans if p['kind'] == 'pause'
              and p['end'] - p['start'] >= 0.15 and p['end'] >= sec(start + 8 * RATE)]
    if not pauses:
        return end
    # 200 ms is shared by 40 ms CTC, 50 ms loudness and 10 ms pitch grids.
    # Keep a margin on both sides so a cut never lands back inside speech.
    for pause in reversed(pauses):
        left = max(start + 8 * RATE, round(pause['start'] * RATE) + 2560)
        right = min(end, round(pause['end'] * RATE) - 2560)
        cut = round((left + right) / 6400) * 3200
        if left <= cut <= right:
            return cut
    return end


class Decoder:
    def __init__(self, path, models, use_vad):
        self.process = subprocess.Popen([
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
            '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
            '-protocol_whitelist', 'file,pipe', '-i', str(path), '-map', '0:a:0',
            '-vn', '-threads', '1', '-f', 'f32le', '-ac', '1', '-ar', str(RATE), 'pipe:1',
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.buffer = np.empty(0, dtype=np.float32)
        self.base = 0
        self.total = 0
        self.eof = False
        self.vad = models.vad() if use_vad else None
        self.speech = deque()
        self.open_speech = None

    def fill(self, target, pulse):
        blocks = []
        while not self.eof and self.total < target:
            data = self.read_frame(pulse)
            if not data:
                self.eof = True
                if self.process.wait(timeout=15) != 0:
                    raise ProcessingError('DECODE_FAILED')
                break
            if len(data) % 4:
                raise ProcessingError('DECODE_TRUNCATED')
            block = np.frombuffer(data, dtype='<f4').copy()
            if not np.isfinite(block).all():
                raise ProcessingError('NONFINITE_PCM')
            blocks.append(block)
            self.total += block.size
            if self.vad:
                event = self.vad(torch.from_numpy(np.pad(block, (0, 512 - block.size))))
                if event and 'start' in event:
                    self.open_speech = event['start']
                if event and 'end' in event:
                    if self.open_speech is not None:
                        self.speech.append((self.open_speech, min(self.total, event['end'])))
                    self.open_speech = None
            pulse()
        if blocks:
            self.buffer = np.concatenate([self.buffer, *blocks])
        if self.buffer.size > LIMIT + 1024:
            raise ProcessingError('DECODE_BUFFER_LIMIT')

    def read_frame(self, pulse):
        data = bytearray()
        deadline = time.monotonic() + 60
        while len(data) < 512 * 4:
            pulse()
            ready, _, _ = select.select([self.process.stdout], [], [], 5)
            if not ready:
                if time.monotonic() >= deadline:
                    raise ProcessingError('DECODE_TIMEOUT')
                continue
            part = os.read(self.process.stdout.fileno(), 512 * 4 - len(data))
            if not part:
                break
            data.extend(part)
        return data

    def spans(self, start, end):
        speech = list(self.speech)
        if self.open_speech is not None:
            speech.append((self.open_speech, self.total))
        return intervals(start, end, speech)

    def samples(self, start, end):
        return self.buffer[start - self.base:end - self.base]

    def discard(self, before):
        before = max(self.base, before)
        self.buffer = self.buffer[before - self.base:].copy()
        self.base = before
        while self.speech and self.speech[0][1] < before:
            self.speech.popleft()

    def close(self):
        self.process.stdout.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def saved_intervals(job, start, end):
    query = {'attempt': job['attempt'], 'from': sec(start), 'to': sec(end), 'cursor': 0}
    items = []
    while True:
        url = (os.environ['AUDIO_API_URL'] + '/internal/audio/' + job['analysisId']
               + '/intervals?' + urllib.parse.urlencode(query))
        request = urllib.request.Request(url, headers={'X-Audio-Token': os.environ['AUDIO_TOKEN']})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(65537)
        if len(data) > 65536:
            raise ProcessingError('INTERVAL_PAGE_LIMIT')
        page = json.loads(data)
        items.extend(page['items'])
        if len(items) > 2048:
            raise ProcessingError('INTERVAL_WINDOW_LIMIT')
        if not page['hasMore']:
            return items
        query['cursor'] = page['nextCursor']


def ctc_words(models, samples, window_start, start, end, checkpoint, final):
    labels = models.labels(samples)
    shift = samples.size / max(1, labels.size)
    words = []
    for frame, label in enumerate(labels):
        position = window_start + frame * shift
        if position < start or position >= end:
            continue
        label = int(label)
        token = models.tokenizer.decode([label]) if label != models.blank else ''
        if label != models.blank and label != checkpoint['lastToken']:
            for character in token:
                if character.isspace():
                    if checkpoint['pendingWord']:
                        words.append({'start': checkpoint['pendingStart'], 'end': checkpoint['pendingEnd'],
                                      'text': checkpoint['pendingWord'], 'timing': 'ctc_estimate'})
                        checkpoint['pendingWord'] = ''
                else:
                    if not checkpoint['pendingWord']:
                        checkpoint['pendingStart'] = sec(position)
                    checkpoint['pendingWord'] += character
                    if len(checkpoint['pendingWord']) > 1024:
                        raise ProcessingError('TRANSCRIPT_TOKEN_LIMIT')
        if token and not token.isspace() and checkpoint['pendingWord']:
            checkpoint['pendingEnd'] = sec(min(end, position + shift))
        checkpoint['lastToken'] = label
    if final and checkpoint['pendingWord']:
        words.append({'start': checkpoint['pendingStart'], 'end': checkpoint['pendingEnd'],
                      'text': checkpoint['pendingWord'], 'timing': 'ctc_estimate'})
        checkpoint['pendingWord'] = ''
    return words


def acoustic(samples, window_start, start, end, checkpoint):
    result = []
    core = samples[start - window_start:end - window_start]
    for offset in range(0, core.size, 800):
        window = core[offset:offset + 800].astype(np.float64)
        peak = float(np.max(np.abs(window)))
        rms = float(np.sqrt(np.mean(window * window)))
        result.append({'kind': 'loudness', 'start': sec(start + offset),
                       'end': sec(start + min(core.size, offset + 800)),
                       'rmsDbfs': 20 * math.log10(rms) if rms > 0 else None,
                       'peakDbfs': 20 * math.log10(peak) if peak > 0 else None,
                       'digitalSilence': peak == 0})
    pitch = None
    selected = None
    pitch_start = 0
    pitch_until = start
    for sample in range(start, end, 160):
        if sample >= pitch_until:
            pitch_start = max(window_start, sample - 1600)
            pitch_until = min(end, sample + 6400)
            pitch_end = min(window_start + samples.size, pitch_until + 1600)
            # Praat 6.1.38 creates one worker per 20 frames. A <=600 ms window
            # has <=56 frames: at most three workers, plus the FFmpeg decoder.
            fragment = samples[pitch_start - window_start:pitch_end - window_start]
            pitch = parselmouth.Sound(fragment, RATE).to_pitch_ac(
                time_step=0.01, pitch_floor=60, pitch_ceiling=600,
                voicing_threshold=0.45) if fragment.size >= 800 else None
            selected = pitch.selected_array if pitch is not None else None
        at = (sample - pitch_start) / RATE
        index = round((at - pitch.x1) / pitch.dx) if pitch is not None else -1
        available = pitch is not None and 0 <= index < pitch.nx
        hz = float(selected['frequency'][index]) if available else 0
        strength = float(selected['strength'][index]) if available else 0
        valid = hz > 0 and strength >= 0.45
        timestamp = sec(sample)
        previous = checkpoint.get('lastF0')
        previous_at = checkpoint.get('lastF0At')
        delta = hz - previous if valid and previous is not None and timestamp - previous_at <= 0.011 else None
        result.append({'kind': 'pitch', 'start': timestamp, 'end': sec(min(end, sample + 160)),
                       'f0Hz': hz if valid else None, 'strength': strength,
                       'deltaHz': delta, 'reason': None if valid else (
                           'insufficient_context' if not available else
                           'unvoiced' if hz == 0 else 'unreliable')})
        if not valid:
            checkpoint['unreliableF0'] = True
        checkpoint['lastF0'] = hz if valid else None
        checkpoint['lastF0At'] = timestamp
    result.sort(key=lambda item: (item['start'], item['kind']))
    return result


def process(job, models, emit, pulse):
    artifact = job['artifactId']
    path = Path('/data/artifacts') / artifact
    if not path.is_file() or path.is_symlink() or path.stat().st_size != job['sizeBytes']:
        raise ProcessingError('SOURCE_UNAVAILABLE')
    checkpoint = dict(job.get('checkpoint') or {})
    checkpoint.setdefault('offset', 0)
    checkpoint.setdefault('lastToken', models.blank)
    checkpoint.setdefault('pendingWord', '')
    checkpoint.setdefault('pendingStart', 0)
    checkpoint.setdefault('pendingEnd', 0)
    checkpoint.setdefault('words', 0)
    checkpoint.setdefault('speechSeconds', 0)
    checkpoint.setdefault('asrCalls', 0)
    checkpoint.setdefault('emotionCalls', 0)
    checkpoint.setdefault('errors', {})
    resume_at = checkpoint['offset']
    full = job['mode'] == 'full'
    asr = not job['transcriptComplete']
    started = time.monotonic()
    cpu_start = time.process_time()
    child_start = resource.getrusage(resource.RUSAGE_CHILDREN)
    decoder = Decoder(path, models, asr)
    start = 0
    try:
        while True:
            decoder.fill(start + CORE + CONTEXT, pulse)
            if decoder.total == start:
                break
            end = min(start + CORE, decoder.total)
            spans = decoder.spans(start, end) if asr else saved_intervals(job, start, end)
            end = choose_end(start, end, spans, decoder.eof and end == decoder.total)
            spans = [{'start': max(sec(start), p['start']), 'end': min(sec(end), p['end']), 'kind': p['kind']}
                     for p in spans if p['end'] > sec(start) and p['start'] < sec(end)]
            if end <= resume_at:
                start = end
                decoder.discard(max(0, start - CONTEXT))
                continue
            if start != checkpoint['offset']:
                raise ProcessingError('CHECKPOINT_BOUNDARY')
            window_start = max(0, start - CONTEXT)
            window_end = min(decoder.total, end + CONTEXT)
            samples = decoder.samples(window_start, window_end)
            final = decoder.eof and end == decoder.total
            data = {'transcript': [], 'intervals': spans if asr else [], 'acoustics': [], 'emotions': []}
            if asr:
                speech = sum(p['end'] - p['start'] for p in spans if p['kind'] == 'speech')
                checkpoint['speechSeconds'] += speech
                if speech > 0 or checkpoint['pendingWord']:
                    try:
                        utterance_end = final or (spans and spans[-1]['kind'] == 'pause'
                            and spans[-1]['end'] - spans[-1]['start'] >= 0.16)
                        data['transcript'] = ctc_words(
                            models, samples, window_start, start, end, checkpoint, utterance_end)
                        checkpoint['asrCalls'] += 1
                        checkpoint['words'] += len(data['transcript'])
                    except Exception:
                        checkpoint['errors']['transcript'] = 'ASR_FAILED'
            if full:
                try:
                    data['acoustics'] = acoustic(samples, window_start, start, end, checkpoint)
                except Exception:
                    checkpoint['errors']['acoustics'] = 'ACOUSTICS_FAILED'
                for span in spans:
                    if span['kind'] != 'speech':
                        continue
                    left, stop = round(span['start'] * RATE), round(span['end'] * RATE)
                    while left < stop:
                        right = min(stop, left + 5 * RATE)
                        item = {'start': sec(left), 'end': sec(right), 'scores': None,
                                'reason': 'too_short' if right - left < RATE else None}
                        if right - left >= RATE:
                            try:
                                item['scores'] = models.emotions(decoder.samples(left, right))
                                checkpoint['emotionCalls'] += 1
                            except Exception:
                                item['reason'] = 'EMOTION_FAILED'
                                checkpoint['errors']['emotions'] = 'EMOTION_FAILED'
                        data['emotions'].append(item)
                        left = right
            checkpoint['offset'] = end
            emit({'type': 'block', 'start': sec(start), 'end': sec(end),
                  'data': data, 'checkpoint': checkpoint})
            start = end
            decoder.discard(max(0, start - CONTEXT))
        if decoder.total == 0:
            raise ProcessingError('EMPTY_AUDIO')
        if asr and checkpoint['pendingWord']:
            word = {'start': checkpoint['pendingStart'], 'end': checkpoint['pendingEnd'],
                    'text': checkpoint['pendingWord'], 'timing': 'ctc_estimate'}
            checkpoint['pendingWord'] = ''
            checkpoint['words'] += 1
            emit({'type': 'block', 'start': sec(decoder.total), 'end': sec(decoder.total),
                  'data': {'transcript': [word]}, 'checkpoint': checkpoint})
        if asr and checkpoint['speechSeconds'] > 0 and checkpoint['words'] == 0:
            checkpoint['errors']['transcript'] = 'SPEECH_WITHOUT_TEXT'
        checkpoint['intervalsComplete'] = True
        emit({'type': 'complete', 'checkpoint': checkpoint, 'duration': sec(decoder.total),
              'wallSeconds': time.monotonic() - started, 'cpuSeconds': time.process_time() - cpu_start +
                  resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime - child_start.ru_utime +
                  resource.getrusage(resource.RUSAGE_CHILDREN).ru_stime - child_start.ru_stime,
              'processPeakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
    finally:
        decoder.close()
