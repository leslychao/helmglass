"""Evaluate the fixed public corpus through deployed Java/MCP and real CPU models.
HELM_AUDIO_CORPUS contains the source WAVs named and hashed in audio-corpus.json.
"""
import hashlib,json,os,re,time
import argparse
from pathlib import Path
from test_mcp_audio import AudioAnalysisTest

def normalized(value):
    return re.sub(r'[^\w\s]', ' ', value.lower().replace('ё','е'), flags=re.UNICODE).split()

def distance(expected, actual):
    row=list(range(len(actual)+1))
    for i,left in enumerate(expected,1):
        next_row=[i]
        for j,right in enumerate(actual,1):
            next_row.append(min(next_row[-1]+1,row[j]+1,row[j-1]+(left!=right)))
        row=next_row
    return row[-1]

def evaluate(t, sample, root):
    path=root/sample['file']
    with path.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=sample['sha256']:raise ValueError('Corpus integrity mismatch')
    category = sample.get('category', sample.get('emotion'))
    artifact,task,digest=t.fixture(path,category)
    started=time.monotonic()
    job=t.tool('audio.analyze',{'artifactId':artifact,'mode':'full'})
    page=t.wait(job['analysisId'])
    if 'emotion' in sample:
        return evaluate_emotions(t, sample, job['analysisId'], page)
    words=[]
    while True:
        words.extend(word['text'] for word in page['items'])
        if not page['hasMore']:break
        page=t.tool('audio.get',{'analysisId':job['analysisId'],'cursor':page['nextCursor']})
    expected=normalized(sample['reference']);actual=normalized(' '.join(words))
    return {'file':sample['file'],'category':sample['category'],'artifactId':artifact,'taskId':task,
        'analysisId':job['analysisId'],'processingVersion':page['processingVersion'],'status':page['status'],
        'stageErrors':page['stageErrors'],'duration':page['durationSeconds'],'metrics':page['metrics'],
        'elapsed':time.monotonic()-started,'referenceWords':len(expected),'wordErrors':distance(expected,actual),
        'text':' '.join(words)}


def evaluate_emotions(t, sample, analysis, state):
    t.assertTrue(state['emotionsComplete'], state)
    totals = {label: 0.0 for label in ('angry', 'sad', 'neutral', 'positive')}
    coverage = 0.0
    segments = 0
    short_segments = 0
    cursor = None
    while True:
        arguments = {'analysisId': analysis, 'section': 'emotions'}
        if cursor:
            arguments['cursor'] = cursor
        page = t.tool('audio.get', arguments)
        t.assertTrue(page['sectionComplete'])
        for item in page['items']:
            duration = item['end'] - item['start']
            t.assertGreater(duration, 0)
            t.assertLessEqual(duration, 5.000001)
            t.assertGreaterEqual(item['start'], 0)
            t.assertLessEqual(item['end'], state['durationSeconds'] + .001)
            scores = item['scores']
            if scores is None:
                t.assertEqual('too_short', item['reason'])
                t.assertLess(duration, 1)
                short_segments += 1
                continue
            t.assertIsNone(item['reason'])
            t.assertGreaterEqual(duration, 1 - .000001)
            t.assertEqual(set(totals), set(scores))
            t.assertAlmostEqual(1, sum(scores.values()), delta=.00001)
            for label, score in scores.items():
                t.assertTrue(0 <= score <= 1)
                totals[label] += duration * score
            coverage += duration
            segments += 1
        if not page['hasMore']:
            break
        t.assertNotEqual(cursor, page['nextCursor'])
        cursor = page['nextCursor']
    predicted = max(totals, key=totals.get) if coverage else None
    return {'file': sample['file'], 'expected': sample['emotion'], 'predicted': predicted,
            'analysisId': analysis, 'processingVersion': state['processingVersion'],
            'status': state['status'], 'coverageSeconds': coverage, 'scoredSegments': segments,
            'shortSegments': short_segments, 'matches': predicted == sample['emotion']}

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--emotions', action='store_true')
    emotions = parser.parse_args().emotions
    manifest=json.loads(Path(__file__).with_name('audio-corpus.json').read_text(encoding='utf-8'))
    root=Path(os.environ.get('HELM_AUDIO_CORPUS','.work/audio-corpus'))
    AudioAnalysisTest.setUpClass();t=AudioAnalysisTest()
    try:
        with Path('.work/audio-benchmark.ndjson').open('w',encoding='utf-8') as output:
            samples = manifest['emotionSamples'] if emotions else manifest['samples']
            matched = 0
            for sample in samples:
                result=evaluate(t,sample,root)
                output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()
                if emotions:
                    matched += result['matches']
                    print(result['file'], result['expected'], result['predicted'], flush=True)
                else:
                    print(result['file'],result['status'],result['wordErrors'],result['referenceWords'],flush=True)
            if emotions:
                print('Emotion label agreement:', matched, '/', len(samples), flush=True)
    finally:AudioAnalysisTest.tearDownClass()
