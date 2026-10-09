FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 OMP_NUM_THREADS=3 MKL_NUM_THREADS=3 OPENBLAS_NUM_THREADS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git=1:2.39.5-0+deb12u3 ffmpeg=7:5.1.9-0+deb12u1 libsndfile1=1.2.0-1+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
RUN git clone https://github.com/salute-developers/GigaAM.git /gigaam \
 && git -C /gigaam checkout 7447938d791c4f3e643386ee22c33777004293a5 \
 && pip install --no-cache-dir --no-deps /gigaam \
 && git clone https://github.com/snakers4/silero-vad.git /silero \
 && git -C /silero checkout 5cd7945676eb32225748052e2e6a0580e4686a08 \
 && pip install --no-cache-dir --no-deps /silero \
 && rm -rf /gigaam /silero

FROM dependencies AS models
COPY prepare_models.py ./
RUN python prepare_models.py

FROM dependencies AS runtime
ENV PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    OMP_WAIT_POLICY=PASSIVE KMP_BLOCKTIME=0
COPY --from=models /models /models
COPY model-lock.json ./
RUN python -c "import json; expected=json.load(open('model-lock.json')); actual=json.load(open('/models/manifest.json')); assert all(actual[k]==v for k,v in expected.items()), 'Official model assets differ from model-lock.json'"
COPY models.py pipeline.py server.py ./
RUN python -c "import hashlib,json,pathlib; p=pathlib.Path('/app'); h=hashlib.sha256(); [h.update(f.read_bytes()) for f in sorted(p.glob('*.py'))]; h.update(pathlib.Path('/models/manifest.json').read_bytes()); h.update(pathlib.Path('requirements.lock').read_bytes()); pathlib.Path('/models/version').write_text(h.hexdigest())"
USER 10001:10001
EXPOSE 8092
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/health', timeout=3).read(1024)"
CMD ["python", "server.py"]
