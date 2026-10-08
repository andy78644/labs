"""Run one scan: fetch fares for every route and date, compare them with past
scans, look for promotions, write data/*.json and send alerts.

    python -m scanner.scan                 # real scan, from flight-watch/
    python -m scanner.scan --provider demo --data-dir /tmp/fw --no-notify
"""

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml

from . import deals as deals_mod
from . import notify, promos
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


def run(args):
    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = date.today()
    origin = cfg["origin"].upper()
    currency = cfg.get("currency", "TWD")
    routes = [r for r in cfg["routes"] if not args.only or r["to"].upper() in args.only]
    for r in routes:
        r["to"] = r["to"].upper()
        r.setdefault("name", r["to"])

    provider = make_provider(
        args.provider, currency, cfg.get("language", "zh-TW"), cfg.get("search", {}).get("adults", 1)
    )
    history = load_json(data_dir / "history.json", {"routes": {}})
    alert_state = load_json(data_dir / "alert_state.json", {})
    alerts_cfg = cfg.get("alerts", {})

    out_routes, all_deals, errors = [], [], []
    for route in routes:
        key = f"{origin}-{route['to']}"
        search = route_search(cfg, route)
        delay = search.get("delay_seconds", 2)
        fares = []
        for dep, ret in trip_dates(search, today):
            fare = None
            for attempt in range(2):
                try:
                    fare = provider.search(origin, route["to"], dep, ret, search.get("max_stops"))
                    break
                except Exception as e:
                    if attempt:
                        errors.append(f"{key} {fare_key(dep, ret)}: {type(e).__name__}: {e}")
                    time.sleep(delay * 3)
            if fare:
                fares.append({
                    "fare_key": fare_key(dep, ret),
                    "depart": dep.isoformat(),
                    "return": ret.isoformat() if ret else None,
                    **fare.to_dict(),
                })
            if args.provider != "demo":
                time.sleep(delay)
            print(f"  {key} {fare_key(dep, ret)}: {fare.price if fare else '-'}", file=sys.stderr)

        scans = history["routes"].get(key, [])
        route_deals, route_median = deals_mod.evaluate_route(route, fares, scans, now, alerts_cfg)
        for d in route_deals:
            d.update(route=key, origin=origin, to=route["to"], name=route["name"])
        all_deals += route_deals

        best = min(fares, key=lambda f: f["price"]) if fares else None
        out_routes.append({
            "key": key,
            "origin": origin,
            "to": route["to"],
            "name": route["name"],
            "alert_below": route.get("alert_below"),
            "best": best,
            "median_best": route_median,
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

    promo_items, new_promos = [], []
    pcfg = cfg.get("promotions", {})
    if pcfg.get("enabled", True) and not args.skip_promos:
        found, perr = promos.scan_promotions(pcfg, routes, now)
        errors += perr
        stored = load_json(data_dir / "promos.json", {"items": []})["items"]
        stored = promos.refilter(pcfg, routes, stored)
        promo_items, new_promos = promos.merge_promotions(
            stored, found, now, pcfg.get("lookback_days", 14) * 2
        )

    fresh = deals_mod.select_new_alerts(all_deals, alert_state, today)
    latest = {
        "generated_at": now.isoformat(),
        "provider": provider.name,
        "origin": origin,
        "currency": currency,
        "routes": out_routes,
        "deals": all_deals,
        "errors": errors,
    }

    message = notify.build_message(fresh, new_promos, currency, os.environ.get("DASHBOARD_URL"))
    print(message or "No new alerts.")
    if errors:
        print("\n".join(["Errors:"] + errors), file=sys.stderr)

    if args.dry_run:
        return latest
    if routes and not any(r["fares"] for r in out_routes):
        # Keep the last good data on disk rather than an empty dashboard.
        print("No fares at all: the provider is probably blocked or broken.", file=sys.stderr)
        sys.exit(1)
    save_json(data_dir / "latest.json", latest)
    save_json(data_dir / "history.json", history)
    save_json(data_dir / "alert_state.json", alert_state)
    if promo_items or new_promos:
        save_json(data_dir / "promos.json", {"updated_at": now.isoformat(), "items": promo_items})
    if not args.no_notify:
        sent, nerr = notify.send(message)
        if sent:
            print("Sent to: " + ", ".join(sent))
        for e in nerr:
            print("Notify error: " + e, file=sys.stderr)
    return latest


def main(argv=None):
    p = argparse.ArgumentParser(description="Scan flight prices and promotions.")
    p.add_argument("--config", default=ROOT / "config.yml")
    p.add_argument("--data-dir", default=ROOT / "data")
    p.add_argument("--provider", default="google", choices=["google", "demo"])
    p.add_argument("--only", nargs="*", type=str.upper, help="only these destination codes")
    p.add_argument("--dry-run", action="store_true", help="do not write files or notify")
    p.add_argument("--no-notify", action="store_true")
    p.add_argument("--skip-promos", action="store_true")
    run(p.parse_args(argv))


if __name__ == "__main__":
    main()
