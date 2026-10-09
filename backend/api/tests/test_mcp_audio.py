"""Original audio transport contract on deployed dev; no acoustic model is invoked."""

import base64
import hashlib
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

from test_dev_contract import DevClient


class McpOriginalAudioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        settings = dict(line.split("=", 1) for line in Path(
            os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")
        ).read_text(encoding="utf-8").splitlines() if line and not line.startswith("#") and "=" in line)
        cls.settings = settings
        cls.client = DevClient(settings, "test", "KEYCLOAK_TEST_PASSWORD")
        cls.owner = cls.client.login_web()["id"]
        cls.client.login_mcp()
        cls.client.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                    "clientInfo": {"name": "helm-original-audio-contract", "version": "1"}})

    def task(self, task_id):
        status, task = self.client.api("/api/tasks/" + task_id)
        self.assertEqual(200, status)
        return task

    def change_fixture_metadata(self, artifact_id, complete=True, size_bytes=39868):
        # Only the artifact freshly created by this test, for its authenticated owner.
        artifact = str(uuid.UUID(artifact_id))
        owner = str(uuid.UUID(self.owner))
        sql = ("UPDATE artifacts SET complete=" + ("true" if complete else "false")
               + ",size_bytes=" + str(int(size_bytes)) + " WHERE id='" + artifact
               + "' AND owner_id='" + owner + "' RETURNING id;")
        result = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "exec", "-i", "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass",
            "-At", "-v", "ON_ERROR_STOP=1"], input=sql, text=True, capture_output=True, timeout=20)
        self.assertEqual(0, result.returncode, "Test-owned artifact metadata update failed")
        self.assertEqual(artifact, result.stdout.splitlines()[0])

    def action(self, task_id, kind, arguments):
        task = self.task(task_id)
        action = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": arguments,
                  "instructionRevision": task["instructionRevision"]}
        if task.get("browser"):
            action["controlEpoch"] = task["browser"]["controlEpoch"]
        error, _, _ = self.client.execute_in_scenario_step({"taskId": task_id, "action": action})
        self.assertFalse(error, "MCP browser action must be accepted")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            error, receipt, _ = self.client.tool("operations.get", {"operationId": action["operationId"]})
            self.assertFalse(error)
            if receipt["status"] in ("SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"):
                self.assertEqual("SUCCEEDED", receipt["status"], "Browser operation must succeed")
                return receipt
            time.sleep(0.5)
        self.fail("MCP operation did not complete within the bounded wait")

    def stop_task(self, task_id):
        task = self.task(task_id)
        if task["status"] == "STOPPED":
            return
        status, _ = self.client.api("/api/tasks/" + task_id + "/commands", "POST",
                                  {"type": "STOP", "expectedVersion": task["version"]})
        self.assertEqual(200, status)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.task(task_id)["status"] == "STOPPED":
                return
            time.sleep(0.5)
        self.fail("The test browser was not confirmed closed")

    def test_original_audio_bytes_and_immutable_assignment_context(self):
        original_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3"
        original_hash = "41191d0727073bf848bcc8f0bd851d71a0b0058e901abb1c1b236ad327bda52e"
        title = "Original audio contract"
        goal = "Preserve original bytes and their assignment; acoustic understanding is not tested here."
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {"title": title, "goal": goal,
                "startUrl": original_url, "prepare": True}})
        self.assertFalse(error)
        task_id = presentation["task"]["id"]
        source_context = {"assignmentId": "synthetic-audio-transport-" + str(uuid.uuid4()),
                          "instruction": "Inspect the original recording and answer the attached question.",
                          "questions": ["What sound is present in the recording?"]}
        try:
            listing = self.action(task_id, "listMedia", {})
            sources = listing["result"]["media"]
            source = next(item for item in sources if item["sourceUrl"] == original_url)
            captured = self.action(task_id, "captureAudio", {
                "sourceId": source["id"], "sourceRef": source_context["assignmentId"],
                "sourceContext": source_context, "name": "original-roar.mp3"})
            artifact = captured["result"]["artifact"]
            task = self.task(task_id)
            revision = task["instructionRevision"]

            def read_audio(delivery=None):
                arguments = {"taskId": task_id, "artifactId": artifact["id"]}
                if delivery is not None:
                    arguments["delivery"] = delivery
                failed, metadata, result = self.client.tool("audio.get", arguments)
                self.assertFalse(failed, "Original audio and its immutable assignment must be available")
                self.assertEqual("READY", metadata["artifact"]["status"])
                self.assertTrue(metadata["artifact"]["complete"])
                self.assertTrue(metadata["originalBytes"])
                self.assertEqual(39868, metadata["artifact"]["sizeBytes"])
                self.assertEqual(original_hash, metadata["artifact"]["sha256"])
                file_delivery = delivery != "audio"
                content_type = "resource" if file_delivery else "audio"
                content = [item for item in result["content"] if item["type"] == content_type]
                self.assertEqual(1, len(content))
                source = content[0]["resource"] if file_delivery else content[0]
                self.assertEqual("audio/mpeg", source["mimeType"])
                if file_delivery:
                    self.assertEqual("helmglass://artifacts/" + artifact["id"]
                                     + "/original-roar.mp3", source["uri"])
                    self.assertFalse(any(item["type"] == "audio" for item in result["content"]))
                # This fixed public 39 KiB sample is deliberately below the inline 8 MiB limit.
                payload = base64.b64decode(source["blob" if file_delivery else "data"], validate=True)
                self.assertEqual(39868, len(payload))
                self.assertEqual(original_hash, hashlib.sha256(payload).hexdigest())
                self.assertEqual({"revision": revision, "title": title, "goal": goal,
                                  "sourceContext": source_context}, metadata["instructionContext"])
                return metadata

            first = read_audio()
            self.assertEqual(first, read_audio("file"), "Delivery format must preserve the original and context")
            self.assertEqual(first, read_audio("audio"), "Explicit AudioContent preserves the same original")
            for invalid_delivery in ("url", None):
                failed, refusal, result = self.client.tool("audio.get", {
                    "taskId": task_id, "artifactId": artifact["id"], "delivery": invalid_delivery})
                self.assertTrue(failed)
                self.assertIn("input validation failed", refusal["message"])
                self.assertIn("/delivery", refusal["message"])
                self.assertFalse(any(item["type"] in ("audio", "resource")
                                     for item in result.get("content", [])))
            stranger = DevClient(self.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
            stranger.login_web()
            stranger.login_mcp()
            failed, own_presentation, _ = stranger.tool("tasks.create", {
                "operationKey": str(uuid.uuid4()), "task": {
                    "title": "Audio file owner boundary", "goal": "Refuse a foreign audio artifact",
                    "startUrl": "https://example.com", "prepare": False}})
            self.assertFalse(failed)
            own_task = own_presentation["task"]["id"]

            def delete_foreign_check_draft():
                self.assertEqual(200, stranger.api("/api/tasks/" + own_task, "DELETE")[0])

            self.addCleanup(delete_foreign_check_draft)
            failed, refusal, result = stranger.tool("audio.get", {
                "taskId": own_task, "artifactId": artifact["id"], "delivery": "file"})
            self.assertTrue(failed)
            self.assertEqual("NOT_FOUND", refusal["code"])
            self.assertFalse(any(item["type"] == "resource" for item in result.get("content", [])))
            status, changed = self.client.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "AMEND", "expectedVersion": task["version"], "title": "Revised current task",
                "goal": "A later instruction must not rewrite an already saved audio assignment.",
                "startUrl": original_url})
            self.assertEqual(200, status)
            self.assertGreater(changed["instructionRevision"], revision)
            self.assertEqual(first, read_audio())
            self.assertEqual(first, read_audio("audio"))
            try:
                for complete, size, expected in [(False, 39868, "FILE_NOT_READY"),
                                                  (True, 8_388_609, "AUDIO_INLINE_LIMIT")]:
                    self.change_fixture_metadata(artifact["id"], complete, size)
                    for delivery in ("audio", "file"):
                        failed, refusal, result = self.client.tool("audio.get", {
                            "taskId": task_id, "artifactId": artifact["id"], "delivery": delivery})
                        self.assertTrue(failed)
                        self.assertEqual(expected, refusal["code"])
                        self.assertFalse(any(item["type"] in ("audio", "resource")
                                             for item in result.get("content", [])))
                    if not complete:
                        status, download_refusal = self.client.api(
                            "/api/artifacts/" + artifact["id"] + "/download")
                        self.assertEqual(409, status, "Incomplete originals must be refused before download headers")
                        self.assertEqual("FILE_NOT_READY", download_refusal["code"])
            finally:
                self.change_fixture_metadata(artifact["id"])
            self.assertEqual(first, read_audio())
            self.stop_task(task_id)
            self.assertEqual(first, read_audio(), "Confirmed original remains available after browser closure")
            self.assertEqual(first, read_audio("audio"))
        finally:
            self.stop_task(task_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
