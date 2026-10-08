"""Send alerts. Every channel is optional and is switched on by setting its
environment variables (as GitHub Actions secrets in CI).

A message is built once per output style: Telegram gets HTML (titles and
prices as links), Discord and the Actions summary get Markdown, the console
gets plain text."""

import html
import json
import os
import re
import urllib.request
from datetime import date

REASON_TEXT = {"below_target": "低於目標價", "price_drop": "比近期中位數便宜"}
WD = "一二三四五六日"


class Fmt:
    def __init__(self, style):
        self.style = style

    def esc(self, s):
        s = str(s)
        if self.style == "html":
            return html.escape(s, quote=False)
        if self.style == "md":
            return re.sub(r"([\\[\]*_~`])", r"\\\1", s)
        return s

    def link(self, text, url):
        if not url:
            return self.esc(text)
        if self.style == "html":
            return f'<a href="{html.escape(url)}">{self.esc(text)}</a>'
        if self.style == "md":
            return f"[{self.esc(text)}](<{url}>)"  # <> stops Discord from embedding a preview
        return f"{text} {url}"

    def bold(self, s):
        if self.style == "html":
            return f"<b>{self.esc(s)}</b>"
        if self.style == "md":
            return f"**{self.esc(s)}**"
        return str(s)


def fmt_price(p, currency):
    return f"{currency} {p:,}"


def md(iso):
    d = date.fromisoformat(iso)
    return f"{d.month}/{d.day}（{WD[d.weekday()]}）"


def trip(d):
    return md(d["depart"]) + (f" → {md(d['return'])}" if d.get("return") else "")


def label(r):
    return f"{r['group']} · {r['name']}" if r.get("group") else r["name"]


def stops(n):
    return "直飛" if n == 0 else f"轉 {n} 次"


def change_text(now, before, currency):
    diff = now - before
    if diff == 0:
        return "持平"
    arrow = "↓" if diff < 0 else "↑"
    return f"{arrow} {abs(diff):,}（{diff / before * 100:+.1f}%）"


def build_message(deals, promos, currency, dashboard_url=None, per_route=3,
                  changes=None, summary=None, style="plain"):
    """deals: new deal fares; promos: new headlines; changes: routes whose cheapest
    fare moved since the last scan; summary: every route, for the daily digest.
    Returns "" when there is nothing to say."""
    f = Fmt(style)
    blocks = []

    if deals:
        lines = [f"🔥 {f.bold('好價')}"]
        by_route = {}
        for d in deals:
            by_route.setdefault(d["route"], []).append(d)
        for group in by_route.values():
            group.sort(key=lambda d: d["price"])
            first = group[0]
            lines.append(f"{f.bold(label(first))}　{f.esc(first['origin'])}→{f.esc(first['to'])}")
            for d in group[:per_route]:
                why = "、".join(REASON_TEXT[r] for r in d["reasons"])
                extra = ""
                if d.get("median") and d.get("samples", 0) >= 3:
                    extra = f"，中位數 {d['median']:,}（{d['change_pct']:+.0f}%）"
                lines.append(f"• {trip(d)} {f.link(fmt_price(d['price'], currency), d.get('url'))} "
                             f"{f.esc(d['airline'])} {stops(d.get('stops', 0))} · {why}{extra}")
            if len(group) > per_route:
                lines.append(f"  …還有 {len(group) - per_route} 個日期")
        blocks.append("\n".join(lines))

    if changes:
        lines = [f"📊 {f.bold('價格變化')}（和上次掃描比）"]
        for r in changes:
            b = r["best"]
            lines.append(f"• {f.esc(label(r))} {f.link(fmt_price(b['price'], currency), b.get('url'))} "
                         f"{change_text(b['price'], r['prev_best'], currency)} · {trip(b)} {f.esc(b['airline'])}")
        blocks.append("\n".join(lines))

    if summary:
        lines = [f"📋 {f.bold('每日票價摘要')}"]
        for r in summary:
            b = r.get("best")
            if not b:
                lines.append(f"• {f.esc(label(r))}：這次沒拿到票價")
                continue
            vs = f" · 比昨天 {change_text(b['price'], r['last_summary'], currency)}" if r.get("last_summary") else ""
            lines.append(f"• {f.esc(label(r))} {f.link(fmt_price(b['price'], currency), b.get('url'))} "
                         f"{trip(b)} {f.esc(b['airline'])} {stops(b.get('stops', 0))}{vs}")
        blocks.append("\n".join(lines))

    if promos:
        lines = [f"📣 {f.bold('優惠活動')}"]
        for p in promos[:8]:
            title = p["title"].rsplit(" - ", 1)[0].strip()
            src = p.get("source")
            lines.append(f"• {f.link(title, p.get('link'))}" + (f"（{f.esc(src)}）" if src else ""))
        if len(promos) > 8:
            lines.append(f"  …還有 {len(promos) - 8} 則，在儀表板看")
        blocks.append("\n".join(lines))

    if not blocks:
        return ""
    if dashboard_url:
        blocks.append(f"👉 {f.link('打開 Flight Watch 儀表板', dashboard_url)}")
    return "\n\n".join(blocks)


def build_messages(*args, **kwargs):
    return {s: build_message(*args, style=s, **kwargs) for s in ("html", "md", "plain")}


def chunks(text, limit):
    """Split on line boundaries so a link or tag is never cut in half."""
    out, cur = [], ""
    for line in text.split("\n"):
        if cur and len(cur) + len(line) + 1 > limit:
            out.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


def _post_json(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


def send(message, env=os.environ):
    """message: a dict from build_messages, or a plain string for every channel.
    Returns the list of channels that were sent to, and errors."""
    if isinstance(message, str):
        message = {"html": html.escape(message, quote=False), "md": message, "plain": message}
    sent, errors = [], []
    if not message.get("plain"):
        return sent, errors
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            for part in chunks(message["html"], 3500):
                _post_json(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    {"chat_id": chat, "text": part, "parse_mode": "HTML", "disable_web_page_preview": True},
                )
            sent.append("telegram")
        except Exception as e:
            errors.append(f"telegram: {e}")
    hook = env.get("DISCORD_WEBHOOK_URL")
    if hook:
        try:
            for part in chunks(message["md"], 1900):
                _post_json(hook, {"content": part})
            sent.append("discord")
        except Exception as e:
            errors.append(f"discord: {e}")
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(message["md"] + "\n")
    return sent, errors


def main():
    """python -m scanner.notify: send a test message to every configured channel."""
    import sys

    url = os.environ.get("DASHBOARD_URL") or "https://andy78644.com/labs/flight-watch/"
    msg = {s: f"✈️ Flight Watch 測試訊息：通知設定成功！之後有好價、價格變化或優惠會發到這裡。\n\n👉 "
              f"{Fmt(s).link('打開 Flight Watch 儀表板', url)}" for s in ("html", "md", "plain")}
    sent, errors = send(msg)
    for e in errors:
        print("Error: " + e, file=sys.stderr)
    if sent:
        print("Sent to: " + ", ".join(sent))
    elif not errors:
        print("Nothing sent: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or DISCORD_WEBHOOK_URL.", file=sys.stderr)
    sys.exit(0 if sent and not errors else 1)


if __name__ == "__main__":
    main()
