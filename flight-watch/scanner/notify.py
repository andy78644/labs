"""Send alerts. Every channel is optional and is switched on by setting its
environment variables (as GitHub Actions secrets in CI)."""

import json
import os
import urllib.request

REASON_TEXT = {"below_target": "低於目標價", "price_drop": "比近期中位數便宜"}


def fmt_price(p, currency):
    return f"{currency} {p:,}"


def build_message(deals, promos, currency, dashboard_url=None, per_route=3):
    lines = []
    if deals:
        lines.append("✈️ 機票降價提醒")
        by_route = {}
        for d in deals:
            by_route.setdefault(d["route"], []).append(d)
        for group in by_route.values():
            group.sort(key=lambda d: d["price"])
            first = group[0]
            lines.append(f"{first['origin']}→{first['to']} {first['name']}")
            for d in group[:per_route]:
                why = "、".join(REASON_TEXT[r] for r in d["reasons"])
                dates = d["depart"] + (f" → {d['return']}" if d.get("return") else "")
                extra = ""
                if d.get("median"):
                    extra = f"（中位數 {fmt_price(d['median'], currency)}，{d['change_pct']:+.0f}%）"
                lines.append(
                    f"• {dates}: {fmt_price(d['price'], currency)} {d['airline']}，{why}{extra}\n  {d['url']}"
                )
            if len(group) > per_route:
                lines.append(f"  …還有 {len(group) - per_route} 個日期")
    if promos:
        if lines:
            lines.append("")
        lines.append("📣 優惠活動")
        for p in promos[:8]:
            lines.append(f"• {p['title']}\n  {p['link']}")
    if lines and dashboard_url:
        lines += ["", dashboard_url]
    return "\n".join(lines)


def _post_json(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


def send(message, env=os.environ):
    """Returns the list of channels that were sent to, and errors."""
    sent, errors = [], []
    if not message:
        return sent, errors
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            _post_json(
                f"https://api.telegram.org/bot{token}/sendMessage",
                {"chat_id": chat, "text": message[:4000], "disable_web_page_preview": True},
            )
            sent.append("telegram")
        except Exception as e:
            errors.append(f"telegram: {e}")
    hook = env.get("DISCORD_WEBHOOK_URL")
    if hook:
        try:
            _post_json(hook, {"content": message[:1900]})
            sent.append("discord")
        except Exception as e:
            errors.append(f"discord: {e}")
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + message + "\n```\n")
    return sent, errors
