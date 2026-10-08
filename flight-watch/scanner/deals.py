"""Turn a scan plus past scans into deal flags, and decide which deals are
new enough to notify about."""

from datetime import datetime, timedelta
from statistics import median


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def past_prices(scans, fare_key, now, baseline_days):
    """Prices this exact fare (same dates) had in earlier scans."""
    cutoff = now - timedelta(days=baseline_days)
    return [
        s["fares"][fare_key]
        for s in scans
        if fare_key in s.get("fares", {}) and parse_time(s["t"]) >= cutoff
    ]


def past_bests(scans, now, baseline_days, keys=None):
    """Each past scan's cheapest fare. With `keys`, only those date pairs
    count, so a route whose dates were edited isn't compared with old ones."""
    cutoff = now - timedelta(days=baseline_days)
    out = []
    for s in scans:
        if parse_time(s["t"]) < cutoff:
            continue
        prices = [p for k, p in s.get("fares", {}).items() if keys is None or k in keys]
        if prices:
            out.append(min(prices))
    return out


def evaluate_route(route, fares, scans, now, alerts):
    """Annotate each fare with its recent median and return the route's deals.

    fares: list of dicts with fare_key, price, ... from this scan.
    scans: earlier scans of this route (current scan not included).
    """
    drop = alerts.get("drop_pct", 15) / 100
    days = alerts.get("baseline_days", 30)
    min_samples = alerts.get("min_samples", 6)
    target = route.get("alert_below")

    deals = []
    for fare in fares:
        prices = past_prices(scans, fare["fare_key"], now, days)
        fare["median"] = int(median(prices)) if prices else None
        fare["samples"] = len(prices)
        fare["change_pct"] = (
            round((fare["price"] - fare["median"]) / fare["median"] * 100, 1)
            if fare["median"]
            else None
        )
        reasons = []
        if target and fare["price"] <= target:
            reasons.append("below_target")
        if len(prices) >= min_samples and fare["price"] <= fare["median"] * (1 - drop):
            reasons.append("price_drop")
        if reasons:
            deals.append({**fare, "reasons": reasons})

    bests = past_bests(scans, now, days, {f["fare_key"] for f in fares})
    route_median = int(median(bests)) if bests else None
    return deals, route_median


def select_new_alerts(deals, state, today):
    """Only alert on a fare the first time it is a deal, or when it gets
    cheaper than the price we last alerted on. Mutates and prunes `state`."""
    for key in [k for k, v in state.items() if v.get("depart", "9999") < today.isoformat()]:
        del state[key]
    fresh = []
    for d in deals:
        key = f'{d["route"]}|{d["fare_key"]}'
        seen = state.get(key)
        if seen and d["price"] >= seen["price"]:
            continue
        state[key] = {"price": d["price"], "depart": d["depart"]}
        fresh.append(d)
    return fresh
