"""Explicit dev fault test: restart the audio executor, then expire its lease.

Requires the pinned corpus prepared by prepare_audio_corpus.py and an idle audio queue.
Only fresh test-owned analyses are changed. Each recording is shorter than one minute.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import wave

from evaluate_audio import normalized
from test_mcp_audio import AudioAnalysisTest


def prepare(t):
    sample = json.loads(Path(__file__).with_name('audio-corpus.json').read_text(encoding='utf-8'))['samples'][0]
    root = Path(os.environ.get('HELM_AUDIO_CORPUS', '.work/audio-corpus'))
    artifact, _, _ = t.fixture(root / sample['file'], 'recovery source')
    result = subprocess.run(t.docker + ['exec', 'helmglass-models-audio-processor-1',
        'ffmpeg', '-v', 'error', '-threads', '1', '-i', '/data/artifacts/' + artifact,
        '-t', '8', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
        capture_output=True, check=True, timeout=30)
    assert len(result.stdout) <= 8 * 16000 * 2
    path = root / 'recovery.wav'
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        output.writeframes(bytes(2 * 16000 * 2))
        for _ in range(6):
            output.writeframes(result.stdout)
        output.writeframes(bytes(16000 * 2))
    return path, len(normalized(sample['reference'])) * 6


def verify(t, path, expected_words, fault):
    assert t.sql("SELECT count(*) FROM audio_analyses WHERE status IN ('RUNNING','QUEUED')") == '0'
    artifact, _, digest = t.fixture(path, fault)
    analysis = t.tool('audio.analyze', {'artifactId': artifact, 'mode': 'full'})['analysisId']
    deadline = time.monotonic() + 30
    while True:
        row = json.loads(t.sql(f"""SELECT json_build_object('status',status,
            'offset',checkpoint->>'offset','attempt',attempt)
            FROM audio_analyses WHERE id='{analysis}'"""))
        if row['status'] == 'RUNNING' and int(row['offset'] or 0) > 0:
            break
        assert time.monotonic() < deadline and row['status'] != 'SUCCEEDED', row
        time.sleep(.05)
    if fault == 'python_restart':
        subprocess.run(t.docker + ['restart', '--time', '0', 'helmglass-models-audio-processor-1'],
                       check=True, capture_output=True, timeout=60)
    else:
        t.sql(f"""UPDATE audio_analyses SET lease_until=now()-interval '1 second'
            WHERE id='{analysis}' AND attempt='{row['attempt']}' AND status='RUNNING'""")
    result = t.wait(analysis)
    assert result['status'] == 'SUCCEEDED', result
    assert result['sourceSha256'] == digest
    count = 0
    while True:
        count += len(result['items'])
        if not result['hasMore']:
            break
        result = t.tool('audio.get', {'analysisId': analysis, 'cursor': result['nextCursor']})
    assert count == expected_words, count
    attempts = int(t.sql(f"SELECT attempts FROM audio_analyses WHERE id='{analysis}'"))
    assert attempts == 2, attempts
    print(json.dumps({'fault': fault, 'analysisId': analysis, 'confirmedSamplesBefore': row['offset'],
                      'attempts': attempts, 'words': count, 'status': result['status']}), flush=True)


def main():
    AudioAnalysisTest.setUpClass()
    t = AudioAnalysisTest()
    try:
        path, words = prepare(t)
        for fault in ('python_restart', 'expired_lease'):
            verify(t, path, words, fault)
    finally:
        AudioAnalysisTest.tearDownClass()


if __name__ == '__main__':
    main()
