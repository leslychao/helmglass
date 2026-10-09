"""Download only the fixed public acceptance sample; verify every source checksum."""
import hashlib
import json
import os
from pathlib import Path
import tarfile
import urllib.request


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(source, sample, root):
    path = root / sample['file']
    temporary = path.with_suffix('.part')
    try:
        with temporary.open('wb') as target:
            copied = 0
            while block := source.read(65536):
                copied += len(block)
                if copied > 8 * 1024 * 1024:
                    raise ValueError('Acceptance clip exceeds the bounded file limit')
                target.write(block)
        if checksum(temporary) != sample['sha256']:
            raise ValueError('Corpus checksum mismatch: ' + sample['file'])
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    manifest = json.loads(Path(__file__).with_name('audio-corpus.json').read_text(encoding='utf-8'))
    root = Path(os.environ.get('HELM_AUDIO_CORPUS', '.work/audio-corpus'))
    root.mkdir(parents=True, exist_ok=True)
    missing = [s for s in manifest['samples'] if not (root / s['file']).exists()
               or checksum(root / s['file']) != s['sha256']]
    fleurs = {s['id'].split('/')[1]: s for s in missing if s['dataset'] == 'google/fleurs'}
    if fleurs:
        revision = next(iter(fleurs.values()))['revision']
        url = f'https://huggingface.co/datasets/google/fleurs/resolve/{revision}/data/ru_ru/audio/test.tar.gz'
        with urllib.request.urlopen(url, timeout=120) as source:
            with tarfile.open(fileobj=source, mode='r|gz') as archive:
                for member in archive:
                    name = Path(member.name).name
                    if name in fleurs:
                        with archive.extractfile(member) as audio:
                            save(audio, fleurs.pop(name), root)
                    if not fleurs:
                        break
        if fleurs:
            raise ValueError('Missing FLEURS samples')
    sova = [s for s in missing if s['dataset'] == 'bond005/sova_rudevices']
    if sova:
        url = ('https://datasets-server.huggingface.co/rows?dataset=bond005%2Fsova_rudevices'
               '&config=default&split=test&offset=0&length=10')
        with urllib.request.urlopen(url, timeout=60) as source:
            page = json.loads(source.read(1024 * 1024))
        for sample in sova:
            row = next(r['row'] for r in page['rows'] if r['row_idx'] == sample['id'])
            audio_url = row['audio'][0]['src']
            if '/--/' + sample['revision'] + '/--/' not in audio_url or row['text'] != sample['reference']:
                raise ValueError('The dataset viewer no longer serves the pinned SOVA revision')
            with urllib.request.urlopen(audio_url, timeout=60) as source:
                save(source, sample, root)
    print('Verified', len(manifest['samples']), 'public audio samples')


if __name__ == '__main__':
    main()
