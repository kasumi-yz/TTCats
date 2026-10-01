"""通过本机假 ComfyUI 服务验证完整调用和失败路径，无需显卡或模型。"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import queue_clip


class FakeComfy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        if self.path == "/object_info":
            workflow = json.loads(queue_clip.WORKFLOW.read_text(encoding="utf-8"))
            info = {}
            for node in workflow.values():
                required = {}
                for field in ("unet_name", "clip_name", "vae_name"):
                    if field in node["inputs"]:
                        required[field] = [[node["inputs"][field]]]
                target = info.setdefault(node["class_type"], {"input": {"required": {}}})["input"]["required"]
                for field, values in required.items():
                    target.setdefault(field, [[]])[0].extend(values[0])
            self.reply(info)
        elif self.path == "/system_stats":
            self.reply({"system": {"comfyui_version": "test"}})
        elif self.path.startswith("/history/"):
            self.server.history_queries += 1
            if self.server.history_failures:
                self.server.history_failures -= 1
                self.reply({"error": "服务暂时忙碌"}, 503)
                return
            if self.server.failed:
                self.reply({"test-id": {"status": {"status_str": "error", "messages": ["显存不足"]}}})
            else:
                self.reply({"test-id": {"status": {"completed": True}, "outputs": {
                    "16": {"images": [{"filename": "result.mp4", "subfolder": "TTCats", "type": "output"}]}
                }}})
        elif self.path.startswith("/view?"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"test-video")
        else:
            self.reply({}, 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/upload/image":
            self.server.uploads.append(body)
            self.reply({"name": f"uploaded-{len(self.server.uploads)}.png", "subfolder": "", "type": "input"})
        elif self.path == "/prompt":
            self.server.submissions += 1
            self.server.prompt = json.loads(body)["prompt"]
            self.reply({"prompt_id": "test-id", "node_errors": {}})
        else:
            self.reply({}, 404)


class QueueClipTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.first = self.root / "首帧.png"
        self.last = self.root / "尾帧.png"
        self.first.write_bytes(b"first-image")
        self.last.write_bytes(b"last-image")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfy)
        self.server.uploads = []
        self.server.failed = False
        self.server.prompt = None
        self.server.submissions = 0
        self.server.history_queries = 0
        self.server.history_failures = 0
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.environment = patch.dict(os.environ, {"TTCATS_ASSET_ROOT": str(self.root)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.folder.cleanup()

    def args(self):
        import argparse
        return argparse.Namespace(first=self.first, last=self.last, prompt="猫从站姿慢慢坐下",
            url=f"http://127.0.0.1:{self.server.server_port}", width=1344, height=768,
            seconds=5, steps=20, seed=6, timeout=2, poll_interval=0.01, check_only=False)

    def test_upload_queue_download_and_asset_log(self):
        queue_clip.run(self.args())
        self.assertIn(b"first-image", self.server.uploads[0])
        self.assertIn(b"last-image", self.server.uploads[1])
        self.assertEqual(self.server.prompt["7"]["inputs"]["first_frame"], ["5", 0])
        self.assertEqual(self.server.prompt["7"]["inputs"]["last_frame"], ["6", 0])
        self.assertEqual(self.server.prompt["7"]["inputs"]["length"], 124)
        inbox = self.root / "inbox"
        self.assertEqual(next(inbox.glob("*.mp4")).read_bytes(), b"test-video")
        log = json.loads(next(inbox.glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(log["status"], "success")
        self.assertEqual(log["prompt_id"], "test-id")
        self.assertEqual(log["outputs"][0]["sha256"], queue_clip.sha256(next(inbox.glob("*.mp4"))))
        self.assertEqual(log["prompt"], self.args().prompt)
        self.assertEqual(log["parameters"]["seed"], 6)
        self.assertEqual(log["parameters"]["steps"], 20)
        self.assertEqual(log["generation_attempt"], 1)
        self.assertFalse(log["model_hash_verification"]["verified_for_this_run"])
        self.assertFalse(list(inbox.glob("*.part")))

    def test_generation_error_preserves_log_without_video(self):
        self.server.failed = True
        with self.assertRaisesRegex(queue_clip.GeneratorError, "显存不足"):
            queue_clip.run(self.args())
        inbox = self.root / "inbox"
        self.assertFalse(list(inbox.glob("*.mp4")))
        self.assertFalse(list(inbox.glob("*.json")))
        log = json.loads(next((self.root / "generation-records").rglob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(log["status"], "failed")
        self.assertEqual(log["prompt_id"], "test-id")
        self.assertEqual(self.server.history_queries, 1)

    def test_retry_recovers_without_resubmitting_generation(self):
        self.server.history_failures = 2
        queue_clip.run(self.args())
        self.assertEqual(self.server.history_queries, 3)
        self.assertEqual(self.server.submissions, 1)
        self.assertEqual(len(list((self.root / "inbox").glob("*.mp4"))), 1)

    def test_retry_limit_preserves_running_task_id(self):
        self.server.history_failures = 10
        with self.assertRaisesRegex(queue_clip.GeneratorError, "尚未确认生成失败"):
            queue_clip.run(self.args())
        self.assertEqual(self.server.history_queries, 4)
        self.assertEqual(self.server.submissions, 1)
        self.assertFalse(list((self.root / "inbox").glob("*.json")))

    def test_attempt_increases_after_failed_generation_with_new_seed(self):
        self.server.failed = True
        with self.assertRaises(queue_clip.GeneratorError):
            queue_clip.run(self.args())
        self.server.failed = False
        args = self.args()
        args.seed = 7
        queue_clip.run(args)
        log = json.loads(next((self.root / "inbox").glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(log["generation_attempt"], 2)
        self.assertEqual(log["parameters"]["seed"], 7)

    def test_timeout_identifies_running_task(self):
        class EmptyHistory:
            def json(self, _):
                return {}
        with self.assertRaisesRegex(queue_clip.GeneratorError, "可能仍在运行"):
            queue_clip.wait_for_result(EmptyHistory(), "still-running", 0.01, 0.01)

    def test_check_only_does_not_submit_or_upload(self):
        args = self.args()
        args.check_only = True
        queue_clip.run(args)
        self.assertEqual(self.server.uploads, [])
        self.assertIsNone(self.server.prompt)


if __name__ == "__main__":
    unittest.main()
