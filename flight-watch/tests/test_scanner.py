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
