"""CPU-only model adapters; every inference input is bounded by twenty seconds."""
import hashlib
import json
from pathlib import Path

import hydra
import numpy as np
import onnxruntime as ort
from omegaconf import OmegaConf
import torch
from silero_vad.utils_vad import OnnxWrapper, VADIterator

torch.set_num_threads(3)
torch.set_num_interop_threads(1)
ROOT = Path('/models')


class Models:
    def __init__(self):
        self.manifest = json.loads((ROOT / 'manifest.json').read_text())
        for name, expected in self.manifest['assets'].items():
            with (ROOT / name).open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                    raise RuntimeError('MODEL_INTEGRITY')
        self.version = (ROOT / 'version').read_text().strip()
        self.configs = {name: OmegaConf.load(ROOT / f'{name}.yaml') for name in ('v3_ctc', 'emo')}
        self.features = {name: hydra.utils.instantiate(cfg.preprocessor)
                         for name, cfg in self.configs.items()}
        self.tokenizer = hydra.utils.instantiate(self.configs['v3_ctc'].decoding).tokenizer
        self.blank = len(self.tokenizer)
        self.sessions = {}
        self.vad_model = OnnxWrapper(str(ROOT / 'silero_vad.onnx'), force_onnx_cpu=True)
        self.session('v3_ctc')

    def session(self, name):
        if name not in self.sessions:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 3
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.add_session_config_entry('session.intra_op.allow_spinning', '0')
            options.add_session_config_entry('session.inter_op.allow_spinning', '0')
            self.sessions[name] = ort.InferenceSession(
                str(ROOT / f'{name}.onnx'), sess_options=options,
                providers=['CPUExecutionProvider'])
        return self.sessions[name]

    def vad(self):
        self.vad_model.reset_states()
        return VADIterator(self.vad_model, sampling_rate=16000,
                           threshold=0.5, min_silence_duration_ms=100, speech_pad_ms=30)

    @torch.inference_mode()
    def infer(self, name, samples):
        if not 1 <= samples.size <= 320000:
            raise ValueError('MODEL_FRAGMENT_LIMIT')
        # Match the official preprocessor, including its float32 scale; no peak normalization.
        waveform = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32)).unsqueeze(0)
        features, lengths = self.features[name](waveform, torch.tensor([samples.size]))
        session = self.session(name)
        inputs = session.get_inputs()
        return session.run(None, {inputs[0].name: features.numpy(), inputs[1].name: lengths.numpy()})

    def labels(self, samples):
        output = self.infer('v3_ctc', samples)
        count = min(int(output[1][0]), output[0].shape[1])
        return output[0][0, :count].argmax(axis=-1)

    def emotions(self, samples):
        scores = self.infer('emo', samples)[0][0]
        names = self.configs['emo'].id2name
        return {str(names[i]): float(value) for i, value in enumerate(scores)}
