import unittest
from datetime import date, datetime, timedelta, timezone

from scanner import deals, promos
from scanner.scan import trip_dates

NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)


def scan(hours_ago, best, fares):
    return {"t": (NOW - timedelta(hours=hours_ago)).isoformat(), "best": best, "fares": fares}


class TripDates(unittest.TestCase):
    def test_fridays_in_window_round_trip(self):
        s = {"trip": "round-trip", "stay_nights": [3, 5], "depart_weekdays": ["fri"], "window_days": [1, 14]}
        pairs = trip_dates(s, date(2026, 10, 8))  # a Thursday
        self.assertEqual([d.isoformat() for d, _ in pairs], ["2026-10-09"] * 2 + ["2026-10-16"] * 2)
        self.assertEqual(pairs[1][1], date(2026, 10, 14))

    def test_explicit_dates_one_way_skip_past(self):
        s = {"trip": "one-way", "dates": ["2026-10-01", "2026-12-24"]}
        self.assertEqual(trip_dates(s, date(2026, 10, 8)), [(date(2026, 12, 24), None)])


class Deals(unittest.TestCase):
    alerts = {"drop_pct": 15, "baseline_days": 30, "min_samples": 3}

    def test_below_target(self):
        fares = [{"fare_key": "a", "price": 8000}, {"fare_key": "b", "price": 9500}]
        found, _ = deals.evaluate_route({"alert_below": 9000}, fares, [], NOW, self.alerts)
        self.assertEqual([d["fare_key"] for d in found], ["a"])
        self.assertIsNone(fares[0]["median"])

    def test_price_drop_needs_enough_samples(self):
        history = [scan(h, 10000, {"a": 10000}) for h in (6, 12)]
        fares = [{"fare_key": "a", "price": 8000}]
        found, _ = deals.evaluate_route({}, fares, history, NOW, self.alerts)
        self.assertEqual(found, [])
        history.append(scan(18, 10000, {"a": 10000}))
        found, route_median = deals.evaluate_route({}, fares, history, NOW, self.alerts)
        self.assertEqual(found[0]["reasons"], ["price_drop"])
        self.assertEqual(found[0]["change_pct"], -20.0)
        self.assertEqual(route_median, 10000)

    def test_old_scans_outside_baseline_ignored(self):
        history = [scan(24 * 40, 20000, {"a": 20000})] * 5
        fares = [{"fare_key": "a", "price": 10000}]
        found, _ = deals.evaluate_route({}, fares, history, NOW, self.alerts)
        self.assertEqual(found, [])

    def test_alert_only_when_new_or_cheaper(self):
        state = {"X|old": {"price": 1, "depart": "2026-01-01"}}
        d = {"route": "X", "fare_key": "k", "price": 8000, "depart": "2026-12-01"}
        today = date(2026, 10, 8)
        self.assertEqual(len(deals.select_new_alerts([d], state, today)), 1)
        self.assertNotIn("X|old", state)
        self.assertEqual(deals.select_new_alerts([dict(d)], state, today), [])
        self.assertEqual(len(deals.select_new_alerts([dict(d, price=7900)], state, today)), 1)


RSS = """<?xml version="1.0"?><rss><channel>
<item><title>長榮東京機票買一送一 - 報A</title><link>https://a</link>
<pubDate>Wed, 07 Oct 2026 06:00:00 GMT</pubDate><source url="x">報A</source></item>
<item><title>長榮東京機票買一送一 - 報B</title><link>https://b</link>
<pubDate>Wed, 07 Oct 2026 07:00:00 GMT</pubDate></item>
<item><title>東京美食優惠</title><link>https://c</link><pubDate>Wed, 07 Oct 2026 06:00:00 GMT</pubDate></item>
<item><title>東京機票優惠 老新聞</title><link>https://d</link><pubDate>Wed, 01 Jan 2025 06:00:00 GMT</pubDate></item>
</channel></rss>"""


class Promos(unittest.TestCase):
    cfg = {"keywords": ["優惠", "買一送一"], "require_any": ["機票"], "lookback_days": 14}

    def test_filters_and_dedupes_syndicated_stories(self):
        routes = [{"to": "NRT", "name": "東京"}]
        items, errors = promos.scan_promotions(self.cfg, routes, NOW, fetcher=lambda url: RSS.encode())
        self.assertEqual(errors, [])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["routes"], ["NRT"])

    def test_merge_reports_only_unseen(self):
        item = {"id": "1", "title": "t", "published": NOW.isoformat()}
        stored, new = promos.merge_promotions([], [dict(item)], NOW, 28)
        self.assertEqual(len(new), 1)
        stored, new = promos.merge_promotions(stored, [dict(item)], NOW, 28)
        self.assertEqual((len(stored), new), (1, []))


if __name__ == "__main__":
    unittest.main()


class AlertDelivery(unittest.TestCase):
    """Deals and promotions only count as alerted once a message is delivered."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "config.yml").write_text(
            "origin: TPE\nsearch: {window_days: [14, 28], depart_weekdays: [fri]}\n"
            "routes: [{to: NRT, name: 東京, alert_below: 999999}]\n"
            "promotions: {keywords: [優惠], require_any: [機票]}\n"
            "notify: {daily_summary: false}\n", encoding="utf-8")
        (self.dir / "promos.json").write_text(
            '{"items": [{"id": "p1", "title": "東京機票優惠", "link": "x", "first_seen": "2099-01-01"}]}', encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, sent):
        import json
        from argparse import Namespace
        from unittest import mock
        from scanner import notify, scan as scan_mod
        args = Namespace(config=self.dir / "config.yml", data_dir=self.dir, provider="demo", only=None,
                         dry_run=False, no_notify=False, skip_promos=False)
        with mock.patch.object(notify, "send", return_value=(sent, [] if sent else ["telegram: 401"])) as m, \
                mock.patch.object(scan_mod.promos, "scan_promotions", return_value=([], [])):
            scan_mod.run(args)
        state = json.loads((self.dir / "alert_state.json").read_text())
        promos_ = json.loads((self.dir / "promos.json").read_text())["items"]
        return m.call_args, state, promos_

    def test_failed_send_is_retried_then_marked(self):
        call, state, items = self.scan(sent=[])
        self.assertIn("東京機票優惠", call.args[0]["plain"])
        self.assertEqual(state, {})
        self.assertFalse(items[0].get("notified"))
        call, state, items = self.scan(sent=["telegram"])
        self.assertIn("好價", call.args[0]["plain"])
        self.assertTrue(state)
        self.assertTrue(items[0]["notified"])
        call, _, _ = self.scan(sent=["telegram"])
        self.assertIsNone(call)  # nothing new: no message at all


class EditedRouteBaseline(unittest.TestCase):
    def test_route_median_only_uses_current_dates(self):
        old = [scan(h, 8000, {"2026-11-06": 8000}) for h in (6, 12, 18)]
        fares = [{"fare_key": "2026-12-25", "price": 20000}]
        _, route_median = deals.evaluate_route({}, fares, old, NOW, {"min_samples": 3})
        self.assertIsNone(route_median)
        old.append(scan(3, 21000, {"2026-12-25": 21000, "2026-11-06": 7000}))
        _, route_median = deals.evaluate_route({}, fares, old, NOW, {"min_samples": 3})
        self.assertEqual(route_median, 21000)


class PriceUpdates(unittest.TestCase):
    def route(self, price, prev=None, key="TPE-NRT"):
        return {"key": key, "name": "東京", "best": {"price": price, "fare_key": "a"},
                "prev_best": prev, "fares": [{"fare_key": "a", "price": price}]}

    def test_changes_are_measured_from_the_last_report(self):
        from scanner.scan import price_updates
        cfg, state = {"daily_summary": False, "min_change_pct": 3}, {}
        changes, _ = price_updates([self.route(10000, prev=10000)], cfg, state, NOW)
        self.assertEqual(changes, [])          # first sight: baseline only
        changes, _ = price_updates([self.route(9800)], cfg, state, NOW)
        self.assertEqual(changes, [])          # -2%: below the threshold
        changes, _ = price_updates([self.route(9600)], cfg, state, NOW)
        self.assertEqual([c["prev_best"] for c in changes], [10000])  # -4% in total
        changes, _ = price_updates([self.route(9600)], cfg, state, NOW)
        self.assertEqual(changes, [])          # reported; new baseline 9600

    def test_daily_summary_once_per_local_day(self):
        from scanner.scan import price_updates
        cfg, state = {"summary_hour": 8, "timezone": "Asia/Taipei"}, {}
        early = datetime(2026, 10, 7, 23, tzinfo=timezone.utc)   # 07:00 in Taipei
        self.assertIsNone(price_updates([self.route(10000)], cfg, state, early)[1])
        late = datetime(2026, 10, 8, 1, tzinfo=timezone.utc)     # 09:00 in Taipei
        changes, summary = price_updates([self.route(9000)], cfg, state, late)
        self.assertEqual((len(summary), changes), (1, []))
        self.assertIsNone(price_updates([self.route(8000)], cfg, state, late + timedelta(hours=6))[1])


class Messages(unittest.TestCase):
    def test_telegram_html_uses_links_and_escapes(self):
        from scanner import notify
        promo = [{"title": "東京 <限時> 買一送一 & 更多 - 某報", "link": "https://x/?a=1&b=2", "source": "某報"}]
        m = notify.build_messages([], promo, "TWD", "https://d/")
        self.assertIn('<a href="https://x/?a=1&amp;b=2">東京 &lt;限時&gt; 買一送一 &amp; 更多</a>（某報）', m["html"])
        self.assertIn("[東京 <限時> 買一送一 & 更多](<https://x/?a=1&b=2>)", m["md"])
        self.assertIn('<a href="https://d/">打開 Flight Watch 儀表板</a>', m["html"])
        self.assertEqual(notify.build_messages([], [], "TWD", "https://d/")["plain"], "")

    def test_chunks_split_on_lines(self):
        from scanner import notify
        parts = notify.chunks("\n".join(["x" * 40] * 10), 100)
        self.assertTrue(all(len(p) <= 100 for p in parts))
        self.assertEqual("\n".join(parts), "\n".join(["x" * 40] * 10))


class ParseResults(unittest.TestCase):
    def test_skips_itineraries_without_a_price(self):
        import json
        from scanner.providers import parse_results

        def leg(frm, to, dep, arr, mins, d1, d2):
            row = [None] * 22
            row[3], row[6], row[8], row[10], row[11], row[20], row[21] = frm, to, dep, arr, mins, d1, d2
            return row
        good = [[None, ["樂桃航空"], [leg("TPE", "HND", [20, 55], [0, 50], 175, [2026, 12, 25], [2026, 12, 26])]],
                [[None, 20370]]]
        bad = [[None, ["X"], [leg("TPE", "NRT", [9], [13], 180, [2026, 12, 25], [2026, 12, 25])]], []]
        payload = [None, None, None, [[good, bad]]]
        page = ("<html><script class=\"ds:1\">AF_initDataCallback({key: 'ds:1', data:"
                + json.dumps(payload) + ", sideChannel: {}});</script></html>")
        opts = parse_results(page)
        self.assertEqual(len(opts), 1)
        o = opts[0]
        self.assertEqual((o.price, o.depart_time, o.arrive_time, o.to_airport, o.stops),
                         (20370, "20:55", "00:50+1", "HND", 0))
