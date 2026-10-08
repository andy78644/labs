import tempfile
import time
import unittest
from argparse import Namespace
from datetime import date, timedelta
from pathlib import Path

import server
from scanner import scan

ROOT = Path(__file__).resolve().parent.parent


def make_app(tmp):
    return server.App(Namespace(config=ROOT / "config.yml", data_dir=Path(tmp), provider="demo",
                                token=None, no_notify=True))


class ServerApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        self.day = (date.today() + timedelta(days=30)).isoformat()

    def tearDown(self):
        self.tmp.cleanup()

    def test_search_runs_and_validates(self):
        end = (date.today() + timedelta(days=36)).isoformat()
        job = self.app.start_search({"to": "nrt", "start": self.day, "end": end, "nights": [3, 5]})
        for _ in range(50):
            if job["status"] == "done":
                break
            time.sleep(0.05)
        self.assertEqual((job["status"], job["total"], len(job["results"])), ("done", 14, 14))
        with self.assertRaises(ValueError):
            self.app.start_search({"to": "TPE", "start": self.day, "end": end})
        with self.assertRaises(ValueError):
            far = (date.today() + timedelta(days=200)).isoformat()
            self.app.start_search({"to": "NRT", "start": self.day, "end": far, "nights": [3, 4]})

    def test_watch_add_unique_key_and_delete(self):
        a = self.app.add_watch({"to": "NRT", "dates": [self.day], "alert_below": 7000})
        self.assertEqual(a["key"], "TPE-NRT-2")  # TPE-NRT is taken by config.yml
        routes = scan.load_routes(self.app.cfg(), self.app.data_dir)
        self.assertIn("TPE-NRT-2", [r["key"] for r in routes])
        self.app.delete_watch("TPE-NRT-2")
        with self.assertRaises(KeyError):
            self.app.delete_watch("TPE-NRT")  # config routes cannot be deleted from the UI


if __name__ == "__main__":
    unittest.main()
