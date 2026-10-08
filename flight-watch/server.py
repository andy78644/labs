"""Flight Watch web server: the dashboard, a live search page and an
optional built-in scheduler, in one process.

    python server.py                         # http://127.0.0.1:8000/
    python server.py --scan-every 6          # also scan every 6 hours
    python server.py --host 0.0.0.0 --token SECRET   # on a server

Standard library only, apart from what the scanner itself needs.
"""

import argparse
import hmac
import json
import os
import re
import sys
import threading
import time
import traceback
import uuid
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scanner import scan
from scanner.providers import make_provider

ROOT = Path(__file__).resolve().parent
IATA = re.compile(r"^[A-Z]{3}$")


def airports(value, label):
    """One or more airport codes ("TPE", "TPE/TSA", ["NRT", "HND"])."""
    codes = scan.parse_codes(value)
    if not codes or not all(IATA.match(c) for c in codes) or len(codes) > 4:
        raise ValueError(f"{label}要是 1–4 個 3 碼機場代碼，例如 TPE 或 TPE/TSA")
    return codes
MAX_QUERIES = 80          # per live search
PARALLEL = 3              # concurrent requests to Google, across all searches
google_slots = threading.BoundedSemaphore(PARALLEL)


class App:
    def __init__(self, opts):
        self.opts = opts
        self.config_path = Path(opts.config)
        self.data_dir = Path(opts.data_dir)
        self.jobs = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=PARALLEL * 2)
        self.scan_state = {"running": False, "last": None, "last_error": None, "next": None, "log": []}

    # ---------- config and watchlist ----------
    def cfg(self):
        return scan.load_config(self.config_path)

    def watchlist_path(self):
        return self.data_dir / "watchlist.json"

    def watchlist(self):
        return scan.load_json(self.watchlist_path(), {"routes": []})

    def save_watchlist(self, wl):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        scan.save_json(self.watchlist_path(), wl)

    def provider(self, cfg):
        return make_provider(self.opts.provider, cfg.get("currency", "TWD"),
                             cfg.get("language", "zh-TW"), cfg.get("search", {}).get("adults", 1))

    def state(self):
        cfg = self.cfg()
        routes = scan.load_routes(cfg, self.data_dir)
        return {
            "origin": cfg["origin"],
            "currency": cfg.get("currency", "TWD"),
            "routes": routes,
            "scan": {k: v for k, v in self.scan_state.items() if k != "log"},
            "scan_log": self.scan_state["log"][-30:],
            "provider": self.opts.provider,
            "needs_token": bool(self.opts.token),
            "max_queries": MAX_QUERIES,
        }

    # ---------- live search ----------
    def start_search(self, body):
        cfg = self.cfg()
        origins = airports(body.get("origin") or cfg["origin"], "出發地")
        dests = airports(body.get("to", ""), "目的地")
        if set(origins) & set(dests):
            raise ValueError("出發地和目的地不能一樣")
        origin, dest = "/".join(origins), "/".join(dests)
        trip = "one-way" if body.get("trip") == "one-way" else "round-trip"
        start = date.fromisoformat(body["start"])
        end = date.fromisoformat(body["end"])
        today = date.today()
        if start <= today:
            start = today + timedelta(days=1)
        if end < start:
            raise ValueError("結束日期要在開始日期之後")
        if end > today + timedelta(days=330):
            raise ValueError("Google Flights 只賣大約 11 個月內的票")
        weekdays = {int(w) for w in body.get("weekdays") or range(7)}
        nights = sorted({int(n) for n in body.get("nights") or [4] if 0 < int(n) < 60})
        max_stops = body.get("max_stops")
        max_stops = None if max_stops in (None, "", "any") else int(max_stops)

        departs = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        departs = [d for d in departs if d.weekday() in weekdays]
        pairs = [(d, d + timedelta(days=n)) for d in departs for n in nights] if trip == "round-trip" \
            else [(d, None) for d in departs]
        if not pairs:
            raise ValueError("這個範圍內沒有符合的日期")
        if len(pairs) > MAX_QUERIES:
            raise ValueError(f"一次最多查 {MAX_QUERIES} 組日期，現在是 {len(pairs)} 組。縮小範圍、少選幾個星期或停留天數。")

        job = {
            "id": uuid.uuid4().hex[:10],
            "kind": "search",
            "status": "running",
            "params": {"origin": origin, "to": dest, "trip": trip, "start": start.isoformat(),
                       "end": end.isoformat(), "weekdays": sorted(weekdays), "nights": nights,
                       "max_stops": max_stops},
            "currency": cfg.get("currency", "TWD"),
            "total": len(pairs),
            "done": 0,
            "results": [],
            "missing": [],
            "errors": [],
            "started": time.time(),
        }
        with self.lock:
            self.jobs[job["id"]] = job
            self._prune_jobs()
        provider = self.provider(cfg)
        delay = cfg.get("search", {}).get("delay_seconds", 2)

        def one(dep, ret):
            with google_slots:
                fare = scan.search_fare(provider, origins, dests, dep, ret, max_stops, delay, job["errors"])
                if self.opts.provider != "demo":
                    time.sleep(delay / 2)
            with self.lock:
                job["done"] += 1
                if fare:
                    job["results"].append(scan.fare_row(dep, ret, fare))
                else:
                    job["missing"].append(scan.fare_key(dep, ret))
                if job["done"] == job["total"]:
                    job["status"] = "done"
                    job["results"].sort(key=lambda f: f["fare_key"])

        for dep, ret in pairs:
            self.pool.submit(one, dep, ret)
        return job

    def _prune_jobs(self):
        cutoff = time.time() - 3600
        for jid in [j for j, v in self.jobs.items() if v["started"] < cutoff]:
            del self.jobs[jid]

    # ---------- watchlist edits ----------
    def add_watch(self, body):
        cfg = self.cfg()
        origins = airports(body.get("origin") or cfg["origin"], "出發地")
        dests = airports(body.get("to", ""), "目的地")
        origin, dest = "/".join(origins), "/".join(dests)
        dates = sorted({date.fromisoformat(d).isoformat() for d in body.get("dates") or []})
        if not dates:
            raise ValueError("至少要有一個出發日期")
        route = {
            "origin": origin,
            "to": dest,
            "name": (str(body.get("name") or "").strip() or dest)[:30],
            "trip": "one-way" if body.get("trip") == "one-way" else "round-trip",
            "dates": dates,
            "stay_nights": [int(n) for n in body.get("nights") or [4]],
            "max_stops": None if body.get("max_stops") in (None, "", "any") else int(body["max_stops"]),
            "added": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
        if body.get("alert_below"):
            route["alert_below"] = int(body["alert_below"])
        taken = {r["key"] for r in scan.load_routes(cfg, self.data_dir)}
        base = f'{"+".join(origins)}-{"+".join(dests)}'
        key, n = base, 2
        while key in taken:
            key, n = f"{base}-{n}", n + 1
        route["key"] = key
        with self.lock:
            wl = self.watchlist()
            wl["routes"].append(route)
            self.save_watchlist(wl)
        return route

    def delete_watch(self, key):
        with self.lock:
            wl = self.watchlist()
            before = len(wl["routes"])
            wl["routes"] = [r for r in wl["routes"] if r.get("key") != key]
            if len(wl["routes"]) == before:
                raise KeyError(key)
            self.save_watchlist(wl)

    # ---------- full scans ----------
    def start_scan(self, reason="manual"):
        with self.lock:
            if self.scan_state["running"]:
                return False
            self.scan_state["running"] = True
        threading.Thread(target=self._scan, args=(reason,), daemon=True).start()
        return True

    def _scan(self, reason):
        st = self.scan_state
        st["log"].append(f"{datetime.now():%m/%d %H:%M} 開始掃描（{reason}）")
        try:
            args = Namespace(config=self.config_path, data_dir=self.data_dir, provider=self.opts.provider,
                             only=None, dry_run=False, no_notify=self.opts.no_notify, skip_promos=False)
            latest = scan.run(args)
            n = sum(len(r["fares"]) for r in latest["routes"])
            st["last_error"] = None
            st["log"].append(f"{datetime.now():%m/%d %H:%M} 完成：{n} 筆票價，{len(latest['errors'])} 個錯誤")
        except Exception as e:
            st["last_error"] = f"{type(e).__name__}: {e}"
            st["log"].append(f"{datetime.now():%m/%d %H:%M} 失敗：{e}")
            traceback.print_exc()
        finally:
            st["last"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
            st["running"] = False
            st["log"] = st["log"][-100:]

    def scheduler(self, hours):
        while True:
            nxt = datetime.now(timezone.utc) + timedelta(hours=hours)
            self.scan_state["next"] = nxt.replace(microsecond=0).isoformat()
            time.sleep(hours * 3600)
            self.start_scan("排程")


class Handler(SimpleHTTPRequestHandler):
    app: App = None

    def log_message(self, fmt, *args):
        if "/api/jobs/" not in str(args[0] if args else ""):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def _authorized(self):
        token = self.app.opts.token
        return not token or hmac.compare_digest(self.headers.get("X-Token", ""), token)

    def do_GET(self):
        if self.path == "/api/state":
            return self._json(200, self.app.state())
        if self.path.startswith("/api/jobs/"):
            job = self.app.jobs.get(self.path.rsplit("/", 1)[-1])
            if not job:
                return self._json(404, {"error": "找不到這個搜尋，可能已經過期"})
            with self.app.lock:
                return self._json(200, job)
        if self.path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        # Static files: only the dashboard, its pages and data/ (not config or code).
        clean = self.path.split("?", 1)[0]
        if clean.startswith("/data/"):
            return self._data_file(clean[len("/data/"):])
        if clean in ("/", "/index.html", "/search.html", "/settings.html", "/common.css") or clean.startswith("/docs/"):
            return super().do_GET()
        self.send_error(404)

    def _data_file(self, name):
        # data/ comes from --data-dir, which need not be the folder next to the pages.
        if not re.fullmatch(r"[a-z_]+\.json", name):
            return self.send_error(404)
        path = self.app.data_dir / name
        if not path.is_file():
            return self.send_error(404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write(self, fn):
        if not self._authorized():
            return self._json(401, {"error": "需要正確的存取密碼（token）"})
        try:
            code, data = fn()
            return self._json(code, data)
        except (ValueError, KeyError, TypeError) as e:
            return self._json(400, {"error": str(e)})

    def do_POST(self):
        if self.path == "/api/search":
            return self._write(lambda: (200, self.app.start_search(self._body())))
        if self.path == "/api/watch":
            return self._write(lambda: (200, self.app.add_watch(self._body())))
        if self.path == "/api/scan":
            return self._write(lambda: (200, {"started": self.app.start_scan()}))
        self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if self.path.startswith("/api/watch/"):
            key = self.path.rsplit("/", 1)[-1]

            def delete():
                self.app.delete_watch(key)
                return 200, {"deleted": key}
            return self._write(delete)
        self._json(404, {"error": "not found"})


def main(argv=None):
    p = argparse.ArgumentParser(description="Flight Watch web UI and scheduler.")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    p.add_argument("--config", default=ROOT / "config.yml")
    p.add_argument("--data-dir", default=ROOT / "data")
    p.add_argument("--provider", default="google", choices=["google", "demo"])
    p.add_argument("--scan-every", type=float, default=0, metavar="HOURS",
                   help="run a full scan every N hours (0 = never; use GitHub Actions instead)")
    p.add_argument("--scan-on-start", action="store_true")
    p.add_argument("--no-notify", action="store_true")
    p.add_argument("--token", default=os.environ.get("FLIGHT_WATCH_TOKEN"),
                   help="password for searches and edits; set this when the server is reachable by others")
    opts = p.parse_args(argv)

    if opts.host not in ("127.0.0.1", "localhost") and not opts.token:
        print("Warning: listening publicly without --token; anyone can run searches and edit the watchlist.",
              file=sys.stderr)
    app = App(opts)
    Handler.app = app
    if opts.scan_every > 0:
        threading.Thread(target=app.scheduler, args=(opts.scan_every,), daemon=True).start()
    if opts.scan_on_start:
        app.start_scan("啟動")
    server = ThreadingHTTPServer((opts.host, opts.port), partial(Handler, directory=str(ROOT)))
    print(f"Flight Watch on http://{opts.host}:{opts.port}/  (search: /search.html)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
