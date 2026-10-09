"""Build-only, pinned official exports. Runtime never downloads model assets."""
import hashlib
import json
from pathlib import Path
import urllib.request

import gigaam
import torch

ROOT = Path('/models')
ROOT.mkdir(exist_ok=True)
torch.set_num_threads(4)
torch.set_num_interop_threads(1)
for name in ('v3_ctc', 'emo'):
    model = gigaam.load_model(name, device='cpu', fp16_encoder=False, download_root='/weights')
    model.to_onnx(dir_path=str(ROOT), dtype=torch.float32)
    del model

revision = '5cd7945676eb32225748052e2e6a0580e4686a08'
urllib.request.urlretrieve(
    f'https://raw.githubusercontent.com/snakers4/silero-vad/{revision}/src/silero_vad/data/silero_vad.onnx',
    ROOT / 'silero_vad.onnx',
)
assets = {}
for path in sorted(ROOT.iterdir()):
    with path.open('rb') as stream:
        assets[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
weights = {}
for path in sorted(Path('/weights').glob('*.ckpt')):
    with path.open('rb') as stream:
        weights[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
manifest = {
    'gigaamRevision': '7447938d791c4f3e643386ee22c33777004293a5',
    'sileroRevision': revision, 'precision': 'FP32', 'provider': 'CPUExecutionProvider',
    'assets': assets, 'weights': weights,
}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True), encoding='utf-8')
