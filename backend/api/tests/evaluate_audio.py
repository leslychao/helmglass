"""Evaluate the fixed public corpus through deployed Java/MCP and real CPU models.
HELM_AUDIO_CORPUS contains the source WAVs named and hashed in audio-corpus.json.
"""
import hashlib,json,os,re,sys,time
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
    artifact,task,digest=t.fixture(path,sample['category'])
    started=time.monotonic()
    job=t.tool('audio.analyze',{'artifactId':artifact,'mode':'full'})
    page=t.wait(job['analysisId']);words=[]
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

if __name__=='__main__':
    manifest=json.loads(Path(__file__).with_name('audio-corpus.json').read_text(encoding='utf-8'))
    root=Path(os.environ.get('HELM_AUDIO_CORPUS','.work/audio-corpus'))
    AudioAnalysisTest.setUpClass();t=AudioAnalysisTest()
    try:
        with Path('.work/audio-benchmark.ndjson').open('w',encoding='utf-8') as output:
            for sample in manifest['samples']:
                result=evaluate(t,sample,root)
                output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()
                print(result['file'],result['status'],result['wordErrors'],result['referenceWords'],flush=True)
    finally:AudioAnalysisTest.tearDownClass()
