"""Run one scan: fetch fares for every route and date, compare them with past
scans, look for promotions, write data/*.json and send alerts.

    python -m scanner.scan                 # real scan, from flight-watch/
    python -m scanner.scan --provider demo --data-dir /tmp/fw --no-notify
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml

from . import deals as deals_mod
from . import notify, promos
from .airports import city
from .providers import make_provider

ROOT = Path(__file__).resolve().parent.parent
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
SEARCH_KEYS = {
    "trip", "stay_nights", "depart_weekdays", "window_days", "dates",
    "max_stops", "delay_seconds",
}


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def route_search(cfg, route):
    s = dict(cfg.get("search", {}))
    s.update({k: v for k, v in route.items() if k in SEARCH_KEYS})
    return s


def trip_dates(search, today):
    """(depart, return) pairs to query. Departures fall on fixed weekdays so
    the same dates come back scan after scan and build up a price history."""
    nights = search.get("stay_nights", [4])
    if isinstance(nights, int):
        nights = [nights]
    round_trip = search.get("trip", "round-trip") == "round-trip"
    if search.get("dates"):
        departs = [date.fromisoformat(str(d)) for d in search["dates"]]
        departs = [d for d in departs if d > today]
    else:
        lo, hi = search.get("window_days", [14, 90])
        days = {WEEKDAYS.index(w.lower()[:3]) for w in search.get("depart_weekdays", ["fri"])}
        departs = [
            today + timedelta(days=n)
            for n in range(lo, hi + 1)
            if (today + timedelta(days=n)).weekday() in days
        ]
    pairs = []
    for d in departs:
        if round_trip:
            pairs += [(d, d + timedelta(days=n)) for n in nights]
        else:
            pairs.append((d, None))
    return pairs


def fare_key(depart, ret):
    return depart.isoformat() + (f"/{ret.isoformat()}" if ret else "")


class NoFaresError(RuntimeError):
    pass


def load_config(path):
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def load_routes(cfg, data_dir):
    """Routes from config.yml plus the ones added in the web UI
    (data/watchlist.json). Each route gets an origin and a unique key."""
    routes = [dict(r) for r in cfg.get("routes", [])]
    routes += [dict(r, source="ui") for r in load_json(Path(data_dir) / "watchlist.json", {"routes": []})["routes"]]
    for r in routes:
        # origin / to may each be several airports searched together, e.g. ["TPE", "TSA"].
        r["origins"] = parse_codes(r.get("origin", cfg["origin"]))
        r["dests"] = parse_codes(r["to"])
        r["origin"], r["to"] = "/".join(r["origins"]), "/".join(r["dests"])
        r["city"] = city(r["dests"])
        r.setdefault("name", r["city"])
        r.setdefault("key", f'{"+".join(r["origins"])}-{"+".join(r["dests"])}')
    return routes


def parse_codes(value):
    """ "TPE", "TPE/TSA", "tpe, tsa" or ["TPE", "TSA"] -> ["TPE", "TSA"]."""
    items = value if isinstance(value, (list, tuple)) else re.split(r"[\s,/+、，]+", str(value))
    codes = []
    for c in items:
        c = str(c).strip().upper()
        if c and c not in codes:
            codes.append(c)
    return codes


def search_fare(provider, origins, dests, dep, ret, max_stops, delay, errors):
    """One query with a single retry. Errors are appended, never raised."""
    for attempt in range(2):
        try:
            return provider.search(origins, dests, dep, ret, max_stops)
        except Exception as e:
            if attempt:
                errors.append(f"{'/'.join(origins)}-{'/'.join(dests)} {fare_key(dep, ret)}: {type(e).__name__}: {e}")
            else:
                time.sleep(delay * 3)
    return None


def fare_row(dep, ret, fare):
    return {
        "fare_key": fare_key(dep, ret),
        "depart": dep.isoformat(),
        "return": ret.isoformat() if ret else None,
        **fare.to_dict(),
    }


def run(args):
    cfg = load_config(args.config)
    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = date.today()
    origin = cfg["origin"].upper()
    currency = cfg.get("currency", "TWD")
    routes = [r for r in load_routes(cfg, data_dir) if not args.only or set(r["dests"]) & set(args.only)]

    provider = make_provider(
        args.provider, currency, cfg.get("language", "zh-TW"), cfg.get("search", {}).get("adults", 1)
    )
    history = load_json(data_dir / "history.json", {"routes": {}})
    alert_state = load_json(data_dir / "alert_state.json", {})
    alerts_cfg = cfg.get("alerts", {})

    out_routes, all_deals, errors = [], [], []
    for route in routes:
        key, r_origin = route["key"], route["origin"]
        search = route_search(cfg, route)
        delay = search.get("delay_seconds", 2)
        fares = []
        for dep, ret in trip_dates(search, today):
            fare = search_fare(provider, route["origins"], route["dests"], dep, ret, search.get("max_stops"), delay, errors)
            if fare:
                fares.append(fare_row(dep, ret, fare))
            if args.provider != "demo":
                time.sleep(delay)
            print(f"  {key} {fare_key(dep, ret)}: {fare.price if fare else '-'}", file=sys.stderr)

        scans = history["routes"].get(key, [])
        keys = {f["fare_key"] for f in fares}
        prev = deals_mod.past_bests(scans[-1:], now, 36500, keys)
        route_deals, route_median = deals_mod.evaluate_route(route, fares, scans, now, alerts_cfg)
        for d in route_deals:
            d.update(route=key, origin=r_origin, to=route["to"], name=route["name"],
                     group=route.get("group"), city=route["city"])
        all_deals += route_deals

        best = min(fares, key=lambda f: f["price"]) if fares else None
        out_routes.append({
            "key": key,
            "origin": r_origin,
            "source": route.get("source", "config"),
            "to": route["to"],
            "name": route["name"],
            "group": route.get("group"),
            "city": route["city"],
            "alert_below": route.get("alert_below"),
            "best": best,
            "median_best": route_median,
            "prev_best": prev[0] if prev else None,
            "fares": fares,
        })
        if fares:
            scans.append({
                "t": now.isoformat(),
                "best": best["price"],
                "fares": {f["fare_key"]: f["price"] for f in fares},
            })
        cutoff = (now - timedelta(days=cfg.get("history_days", 180))).isoformat()
        history["routes"][key] = [s for s in scans if s["t"] >= cutoff]

    promo_items = []
    pcfg = cfg.get("promotions", {})
    if pcfg.get("enabled", True) and not args.skip_promos:
        found, perr = promos.scan_promotions(pcfg, routes, now)
        errors += perr
        stored = load_json(data_dir / "promos.json", {"items": []})["items"]
        stored = promos.refilter(pcfg, routes, stored)
        promo_items, _ = promos.merge_promotions(stored, found, now, pcfg.get("lookback_days", 14) * 2)
    # Promotions not yet delivered to any channel (kept until a send succeeds).
    pending_promos = [p for p in promo_items if not p.get("notified")]

    # Work on a copy: deals only count as alerted once a message is delivered.
    new_state = dict(alert_state)
    fresh = deals_mod.select_new_alerts(all_deals, new_state, today)
    latest = {
        "generated_at": now.isoformat(),
        "provider": provider.name,
        "origin": origin,
        "currency": currency,
        "routes": out_routes,
        "deals": all_deals,
        "errors": errors,
    }

    ncfg = cfg.get("notify", {})
    notify_state = load_json(data_dir / "notify_state.json", {})
    new_notify_state = json.loads(json.dumps(notify_state))
    changes, summary = price_updates(out_routes, ncfg, new_notify_state, now)
    dashboard = os.environ.get("DASHBOARD_URL") or ncfg.get("dashboard_url")
    messages = notify.build_messages(fresh, pending_promos, currency, dashboard, changes=changes, summary=summary)
    message = messages["plain"]
    print(message or "No new alerts.")
    if errors:
        print("\n".join(["Errors:"] + errors), file=sys.stderr)

    if args.dry_run:
        return latest
    if routes and not any(r["fares"] for r in out_routes):
        # Keep the last good data on disk rather than an empty dashboard.
        raise NoFaresError("No fares at all: the provider is probably blocked or broken.")
    save_json(data_dir / "latest.json", latest)
    save_json(data_dir / "history.json", history)
    delivered = False
    if message and not args.no_notify:
        sent, nerr = notify.send(messages)
        delivered = bool(sent)
        print(("Sent to: " + ", ".join(sent)) if sent else "Not delivered to any channel; will retry next scan.")
        for e in nerr:
            print("Notify error: " + e, file=sys.stderr)
    if delivered or not message:
        alert_state = new_state  # with no message this only drops past dates
        notify_state = new_notify_state  # likewise: only first-time baselines change
    if delivered:
        for p in pending_promos:
            p["notified"] = True
    save_json(data_dir / "alert_state.json", alert_state)
    save_json(data_dir / "notify_state.json", notify_state)
    if promo_items:
        save_json(data_dir / "promos.json", {"updated_at": now.isoformat(), "items": promo_items})
    return latest


def price_updates(out_routes, ncfg, state, now):
    """Which routes to report as price changes, and the daily summary if one is
    due. Updates `state` as if the message will be delivered.

    A change is measured against the price last reported for the route (not
    just the previous scan), so slow drifts are still reported once they add up."""
    from zoneinfo import ZoneInfo

    local = now.astimezone(ZoneInfo(ncfg.get("timezone", "Asia/Taipei")))
    reported = state.setdefault("reported", {})
    changes = []
    for r in out_routes:
        if not r["best"]:
            continue
        keys = sorted(f["fare_key"] for f in r["fares"])
        base = reported.get(r["key"])
        if not base or base.get("keys") != keys:
            # New or edited route: start from the previous scan (or this one), say nothing yet.
            reported[r["key"]] = {"price": r["prev_best"] or r["best"]["price"], "keys": keys}
            base = reported[r["key"]]
        moved = abs(r["best"]["price"] - base["price"]) / base["price"] * 100
        if ncfg.get("price_changes", True) and moved >= ncfg.get("min_change_pct", 3):
            changes.append({**r, "prev_best": base["price"]})
            reported[r["key"]] = {"price": r["best"]["price"], "keys": keys}
    live = {r["key"] for r in out_routes}
    for k in [k for k in reported if k not in live]:
        del reported[k]

    summary = None
    daily = state.setdefault("summary", {})
    if ncfg.get("daily_summary", True) and local.hour >= ncfg.get("summary_hour", 8) \
            and daily.get("date") != local.date().isoformat():
        last = daily.get("best", {})
        summary = [{**r, "last_summary": last.get(r["key"])} for r in out_routes]
        state["summary"] = {"date": local.date().isoformat(),
                            "best": {r["key"]: r["best"]["price"] for r in out_routes if r["best"]}}
        changes = []  # the summary already lists every route
        for r in out_routes:
            if r["best"]:
                reported[r["key"]] = {"price": r["best"]["price"], "keys": sorted(f["fare_key"] for f in r["fares"])}
    return changes, summary


def main(argv=None):
    p = argparse.ArgumentParser(description="Scan flight prices and promotions.")
    p.add_argument("--config", default=ROOT / "config.yml")
    p.add_argument("--data-dir", default=ROOT / "data")
    p.add_argument("--provider", default="google", choices=["google", "demo"])
    p.add_argument("--only", nargs="*", type=str.upper, help="only these destination codes")
    p.add_argument("--dry-run", action="store_true", help="do not write files or notify")
    p.add_argument("--no-notify", action="store_true")
    p.add_argument("--skip-promos", action="store_true")
    try:
        run(p.parse_args(argv))
    except NoFaresError as e:
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
