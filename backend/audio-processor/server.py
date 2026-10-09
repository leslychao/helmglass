"""Private single-executor HTTP boundary. No queue, user state or persisted results."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import time
import uuid

from models import Models
from pipeline import ProcessingError, process

MODELS = Models()
TOKEN = os.environ['AUDIO_TOKEN']
if len(TOKEN) < 32:
    raise RuntimeError('AUDIO_TOKEN must contain at least 32 characters')
SLOT = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Neither recordings nor service credentials belong in HTTP logs.

    def authorized(self):
        return hmac.compare_digest(self.headers.get('X-Audio-Token', ''), TOKEN)

    def result(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            self.result(200, {'ready': True})
        elif self.path == '/metadata' and self.authorized():
            self.result(200, {'processingVersion': MODELS.version, 'models': MODELS.manifest,
                             'measurement': {'signal': 'decoded_16k_mono_without_gain_normalization',
                                             'rmsWindowSeconds': 0.05, 'pitchStepSeconds': 0.01,
                                             'pitchCoreSeconds': 0.4, 'pitchContextSeconds': 0.1,
                                             'pitchFloorHz': 60, 'pitchCeilingHz': 600},
                             'limitations': ['CTC timestamps are estimates.',
                                             'Emotion scores are uncalibrated classifier scores.',
                                             'Speakers are not separated; overlapping voices limit interpretation.']})
        else:
            self.result(404, {'code': 'NOT_FOUND'})

    def do_POST(self):
        if self.path != '/process' or not self.authorized():
            self.result(403, {'code': 'FORBIDDEN'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 32768:
                raise ValueError()
            job = json.loads(self.rfile.read(length))
            for key in ('analysisId', 'artifactId', 'attempt'):
                if str(uuid.UUID(job[key])) != job[key]:
                    raise ValueError()
            if job['mode'] not in ('transcript', 'full'):
                raise ValueError()
            if not isinstance(job['transcriptComplete'], bool) or not isinstance(job['sizeBytes'], int):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            self.result(400, {'code': 'INVALID_JOB'})
            return
        if job.get('processingVersion') != MODELS.version:
            self.result(412, {'code': 'PROCESSOR_VERSION_CHANGED'})
            return
        if not SLOT.acquire(blocking=False):
            self.result(409, {'code': 'BUSY'})
            return
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Connection', 'close')
            self.end_headers()
            write_lock = threading.Lock()
            stopped = threading.Event()

            def emit(value):
                payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
                if len(payload) > 1024 * 1024:
                    raise ProcessingError('OUTPUT_BLOCK_LIMIT')
                with write_lock:
                    self.wfile.write(payload + b'\n')
                    self.wfile.flush()

            def heartbeat():
                while not stopped.wait(5):
                    try:
                        emit({'type': 'heartbeat'})
                    except OSError:
                        stopped.set()

            def pulse():
                if stopped.is_set():
                    raise ProcessingError('CLIENT_DISCONNECTED')

            thread = threading.Thread(target=heartbeat, daemon=True)
            thread.start()
            try:
                process(job, MODELS, emit, pulse)
            except ProcessingError as error:
                emit({'type': 'error', 'code': error.code})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                emit({'type': 'error', 'code': 'PROCESSING_FAILED'})
            finally:
                stopped.set()
                thread.join(timeout=6)
        finally:
            SLOT.release()
            self.close_connection = True


ThreadingHTTPServer(('0.0.0.0', 8092), Handler).serve_forever()
