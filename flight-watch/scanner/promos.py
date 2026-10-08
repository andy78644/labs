"""Promotion watcher: searches Google News RSS for fare-sale stories about
each destination, plus any extra RSS/Atom feeds from the config."""

import hashlib
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

UA = "Mozilla/5.0 (flight-watch; personal feed reader)"
ATOM = "{http://www.w3.org/2005/Atom}"


def google_news_url(terms, lookback_days):
    q = " ".join(terms) + f" when:{lookback_days}d"
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": q, "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"}
    )


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _date(text):
    if not text:
        return None
    try:
        d = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter("item"):
        source = it.find("source")
        items.append({
            "title": (it.findtext("title") or "").strip(),
            "link": (it.findtext("link") or "").strip(),
            "published": _date(it.findtext("pubDate")),
            "source": source.text.strip() if source is not None and source.text else "",
        })
    for it in root.iter(f"{ATOM}entry"):
        link = it.find(f"{ATOM}link")
        items.append({
            "title": (it.findtext(f"{ATOM}title") or "").strip(),
            "link": link.get("href", "") if link is not None else "",
            "published": _date(it.findtext(f"{ATOM}updated") or it.findtext(f"{ATOM}published")),
            "source": "",
        })
    return items


def matches(title, names, keywords, require=(), exclude=()):
    t = title.lower()
    return (
        any(n.lower() in t for n in names)
        and any(k.lower() in t for k in keywords)
        and (not require or any(k.lower() in t for k in require))
        and not any(k.lower() in t for k in exclude)
    )


def headline(title):
    """Google News appends " - Source"; the same story is often syndicated
    under several links, so the headline alone identifies it."""
    return title.rsplit(" - ", 1)[0].strip()


def refilter(cfg, routes, items):
    """Re-apply the current filters to stored items, so a config change
    also cleans up what is already on the dashboard."""
    names = [r["name"] for r in routes] + [r["to"] for r in routes]
    return [
        it for it in items
        if matches(it["title"], names, cfg.get("keywords", []),
                   cfg.get("require_any", []), cfg.get("exclude", []))
    ]


def item_id(item):
    return hashlib.sha1(headline(item["title"]).encode()).hexdigest()[:16]


def scan_promotions(cfg, routes, now, fetcher=fetch):
    """Returns (items, errors). Each item has route names it matched."""
    lookback = cfg.get("lookback_days", 14)
    keywords = cfg.get("keywords", [])
    require = cfg.get("require_any", [])
    exclude = cfg.get("exclude", [])
    terms = cfg.get("query_terms", ["機票", "優惠"])
    cutoff = now - timedelta(days=lookback)

    sources = [(r["name"], google_news_url(terms + [r["name"]], lookback)) for r in routes]
    sources += [(f.get("name", f["url"]), f["url"]) for f in cfg.get("feeds", [])]
    names = [r["name"] for r in routes] + [r["to"] for r in routes]

    found, errors = {}, []
    for label, url in sources:
        try:
            items = parse_feed(fetcher(url))
        except Exception as e:  # one broken feed should not stop the scan
            errors.append(f"promo feed {label}: {e}")
            continue
        for it in items:
            if it["published"] and it["published"] < cutoff:
                continue
            if not matches(it["title"], names, keywords, require, exclude):
                continue
            iid = item_id(it)
            entry = found.setdefault(iid, {
                "id": iid,
                "title": it["title"],
                "link": it["link"],
                "source": it["source"] or label,
                "published": it["published"].isoformat() if it["published"] else None,
                "routes": [],
            })
            for r in routes:
                if (r["name"].lower() in it["title"].lower() or r["to"] in it["title"]) and r["to"] not in entry["routes"]:
                    entry["routes"].append(r["to"])
    items = sorted(found.values(), key=lambda x: x["published"] or "", reverse=True)
    return items, errors


def merge_promotions(previous, items, now, keep_days):
    """Merge new items into the stored list. Returns (stored, new_items)."""
    known = {p["id"]: p for p in previous}
    new = [it for it in items if it["id"] not in known]
    for it in new:
        it["first_seen"] = now.isoformat()
        known[it["id"]] = it
    cutoff = (now - timedelta(days=keep_days)).isoformat()
    stored = [p for p in known.values() if (p.get("published") or p["first_seen"]) >= cutoff]
    stored.sort(key=lambda x: x.get("published") or x["first_seen"], reverse=True)
    return stored, new
