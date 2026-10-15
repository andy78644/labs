"""Fare sources. Each provider answers one question: the flight options for
given origin and destination airports and a date pair, cheapest first."""

import base64
import hashlib
import math
from dataclasses import dataclass, asdict, field
from datetime import date

MAX_OPTIONS = 12   # kept per date pair, so the dashboard filters have choices

# Low-cost carriers seen on routes from Taiwan; "排除廉航" drops these.
LCC = {
    "IT", "MM", "GK", "TR", "7C", "LJ", "TW", "ZE", "BX", "RS", "UO", "SL", "FD", "AK", "D7", "Z2",
    "5J", "VJ", "VZ", "3K", "JQ", "BC", "9C", "XJ", "DD", "QG", "JW", "TZ", "IJ", "6J", "OD",
}

CABINS = {"economy", "premium-economy", "business", "first"}


@dataclass
class Option:
    price: int
    airline: str
    stops: int
    duration_min: int      # door to door for the outbound flight, layovers included
    depart_time: str       # "HH:MM" local time of the first leg
    arrive_time: str       # "HH:MM", with "+1" when it lands the next day
    from_airport: str
    to_airport: str
    via: list = field(default_factory=list)
    airline_codes: list = field(default_factory=list)
    flight_numbers: list = field(default_factory=list)
    google_best: bool = False   # in Google's own "best flights" list
    recommended: bool = False   # our pick, see recommend()


@dataclass
class Fare:
    """The cheapest option's fields at the top level, plus all kept options."""
    price: int
    airline: str
    stops: int
    duration_min: int
    depart_time: str
    url: str
    options: list = field(default_factory=list)
    recommended: dict = None

    def to_dict(self):
        return asdict(self)


def hour(hhmm):
    return int(hhmm.split(":")[0]) if hhmm else 12


def is_redeye(o):
    """Leaves before 06:00 or after 22:00, or lands after midnight."""
    h = hour(o.depart_time)
    late_arrival = "+" in (o.arrive_time or "") and hour(o.arrive_time.split("+")[0]) < 6
    return h < 6 or h >= 22 or late_arrival


def score(o, fastest):
    """Price with penalties for what makes a flight worse than its price:
    +12 % per stop, +4 % per hour slower than the fastest, +8 % for red-eye
    times. The dashboard uses the same formula (index.html: recommend)."""
    extra_hours = max(0, (o.duration_min - fastest) / 60)
    return o.price * (1 + 0.12 * o.stops + 0.04 * extra_hours + 0.08 * is_redeye(o))


def recommend(options):
    if not options:
        return None
    fastest = min(o.duration_min for o in options)
    return min(options, key=lambda o: (score(o, fastest), o.price))


def pick_options(options, limit=MAX_OPTIONS):
    """Cheapest first, one per airline/departure time, and always keep the
    cheapest nonstop, the fastest, Google's picks and our recommendation."""
    options = sorted(options, key=lambda o: (o.price, o.duration_min))
    seen, picked = set(), []
    for o in options:
        k = (o.airline, o.depart_time, o.stops)
        if k not in seen:
            seen.add(k)
            picked.append(o)
    if not picked:
        return []
    rec = recommend(picked)
    keep = picked[:limit]
    extras = [
        rec,
        next((o for o in picked if o.stops == 0), None),
        min(picked, key=lambda o: o.duration_min),
        *[o for o in picked if o.google_best][:3],
    ]
    for e in extras:
        if e is not None and e not in keep:
            # drop the most expensive option that is not itself an extra
            for i in range(len(keep) - 1, -1, -1):
                if len(keep) < limit:
                    break
                if keep[i] not in extras:
                    del keep[i]
                    break
            keep.append(e)
    for o in keep:
        o.recommended = o is rec
    return sorted(keep, key=lambda o: (o.price, o.duration_min))


def apply_filters(options, opts):
    """Filters Google can't do (exactly) itself: excluded airlines or all
    low-cost ones, and "only these airlines", which Google widens to codeshare
    partners (a CI filter also returns JAL-operated flights)."""
    exclude = set(opts.get("exclude_airlines") or [])
    if opts.get("no_lcc"):
        exclude |= LCC
    only = set(opts.get("airlines") or [])
    return [o for o in options
            if not set(o.airline_codes) & exclude
            and (not only or not o.airline_codes or set(o.airline_codes) <= only)]


def make_fare(options, url):
    if not options:
        return None
    best = options[0]
    rec = next((o for o in options if o.recommended), None)
    return Fare(
        price=best.price, airline=best.airline, stops=best.stops, duration_min=best.duration_min,
        depart_time=best.depart_time, url=url, options=[asdict(o) for o in options],
        recommended=asdict(rec) if rec else None,
    )


# ---------- protobuf helpers: Google Flights accepts several airports per leg ----------

def _varint(n):
    out = b""
    while True:
        b, n = n & 0x7F, n >> 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _field(num, payload):
    return _varint(num << 3 | 2) + _varint(len(payload)) + payload


class GoogleBusyError(RuntimeError):
    """Google answered with an error page instead of results. It is usually
    momentary: the same query a few seconds later works."""


def parse_results(html):
    """Read Google's embedded result data into Options. Same layout as
    fast_flights.parser, but one malformed itinerary (say, one without a
    price) is skipped instead of failing the whole date."""
    import json
    from selectolax.lexbor import LexborHTMLParser

    script = LexborHTMLParser(html).css_first(r"script.ds\:1")
    if script is None:
        raise GoogleBusyError("no result data in the page (blocked or changed?)")
    data = script.text().split("data:", 1)[1].rsplit(",", 1)[0]
    if data.endswith("errorHasStatus: true"):
        raise GoogleBusyError("Google returned an error page")
    payload = json.loads(data)
    hhmm = lambda v: "%02d:%02d" % tuple((x or 0) for x in [*(v or []), None, None][:2])
    options = []
    # payload[2] holds Google's "best flights" (often the cheapest ones) and
    # payload[3] "other flights"; either can be empty, so read both.
    items = []
    for i in (2, 3):
        block = payload[i] if len(payload) > i else None
        if block and block[0]:
            items += [(k, i == 2) for k in block[0]]
    for k, google_best in items:
        try:
            flight, price = k[0], k[1][0][1]
            legs = flight[2]
            first, last = legs[0], legs[-1]
            arrive = hhmm(last[10])
            days = (date(*last[21]) - date(*first[20])).days
            if days > 0:
                arrive += f"+{days}"
            codes, numbers = [], []
            for leg in legs:
                info = leg[22] if len(leg) > 22 and isinstance(leg[22], list) else None
                if info and info[0]:
                    numbers.append(f"{info[0]}{info[1] or ''}")
                    if info[0] not in codes:
                        codes.append(info[0])
            total = flight[9] if len(flight) > 9 and isinstance(flight[9], int) else None
            options.append(Option(
                price=int(price),
                airline=" / ".join(flight[1]),
                stops=len(legs) - 1,
                duration_min=total or sum(l[11] for l in legs),
                depart_time=hhmm(first[8]),
                arrive_time=arrive,
                from_airport=first[3],
                to_airport=last[6],
                via=[l[6] for l in legs[:-1]],
                airline_codes=codes,
                flight_numbers=numbers,
                google_best=google_best,
            ))
        except (IndexError, TypeError, ValueError):
            continue
    unique = {}
    for o in options:
        key = (o.price, o.airline, o.depart_time, o.arrive_time, o.from_airport, o.to_airport)
        if key in unique:
            unique[key].google_best |= o.google_best
        else:
            unique[key] = o
    return [o for o in unique.values() if o.price > 0]


class GoogleFlightsProvider:
    """Google Flights through the fast-flights scraper. No API key needed,
    but it is an unofficial interface: keep the request rate low."""

    name = "google"
    URL = "https://www.google.com/travel/flights"

    def __init__(self, currency, language, adults=1):
        from fast_flights import FlightQuery, Passengers, create_query
        from fast_flights.pb.flights_pb2 import Airport
        from primp import Client

        self._FlightQuery = FlightQuery
        self._Passengers = Passengers
        self._create_query = create_query
        self._Airport = Airport
        self._client = Client(impersonate="chrome_145", impersonate_os="macos", referer=True, cookie_store=True)
        self.currency = currency
        self.language = language
        self.adults = adults

    def _tfs(self, origins, dests, depart, ret, max_stops, opts=None):
        """fast-flights encodes one airport per leg. Google's own format repeats
        the airport fields (13 = from, 14 = to), so extra airports are appended.

        opts: depart_hours / return_hours ([earliest, latest] departure hour of
        each leg), airlines (only these codes), cabin, adults."""
        opts = opts or {}
        legs = [(depart, origins, dests, opts.get("depart_hours"))]
        if ret:
            legs.append((ret, dests, origins, opts.get("return_hours")))
        flights = []
        for d, f, t, hours in legs:
            kw = {}
            if hours:
                kw["earliest_departure_hour"], kw["latest_departure_hour"] = int(hours[0]), int(hours[1])
            if opts.get("airlines"):
                kw["airlines"] = list(opts["airlines"])
            flights.append(self._FlightQuery(date=d.isoformat(), from_airport=f[0], to_airport=t[0], **kw))
        cabin = opts.get("cabin") if opts.get("cabin") in CABINS else "economy"
        query = self._create_query(
            flights=flights,
            seat=cabin,
            trip="round-trip" if ret else "one-way",
            passengers=self._Passengers(adults=int(opts.get("adults") or self.adults)),
            currency=self.currency,
            language=self.language,
            max_stops=max_stops,
        )
        info = query.pb()
        datas = list(info.data)
        del info.data[:]
        out = info.SerializeToString()
        for fd, (_, f, t, _h) in zip(datas, legs):
            b = fd.SerializeToString()
            b += b"".join(_field(13, self._Airport(airport=a).SerializeToString()) for a in f[1:])
            b += b"".join(_field(14, self._Airport(airport=a).SerializeToString()) for a in t[1:])
            out += _field(3, b)
        return base64.b64encode(out).decode()

    def search(self, origins, dests, depart, ret=None, max_stops=None, opts=None):
        opts = opts or {}
        tfs = self._tfs(origins, dests, depart, ret, max_stops, opts)
        params = {"tfs": tfs, "hl": self.language, "curr": self.currency}
        url = f"{self.URL}/search?tfs={tfs}&hl={self.language}&curr={self.currency}"
        html = self._client.get(self.URL, params=params).text
        return make_fare(pick_options(apply_filters(parse_results(html), opts)), url)


class DemoProvider:
    """Deterministic made-up fares for trying the pipeline offline."""

    name = "demo"

    def __init__(self, currency="TWD", seed=""):
        self.currency = currency
        self.seed = seed

    def search(self, origins, dests, depart, ret=None, max_stops=None, opts=None):
        o, d = origins[0], dests[0]
        h = int(hashlib.sha256(f"{o}{d}{self.seed}".encode()).hexdigest(), 16)
        base = 6000 + h % 9000
        days_out = (depart - date.today()).days
        wobble = math.sin(depart.toordinal() / 3 + h % 7) * 0.18
        lead = 0.25 if days_out < 21 else 0.0
        price = int(round(base * (1 + wobble + lead) / 10) * 10)
        options = [
            Option(price=price + i * 730, airline=name, stops=stops, duration_min=180 + h % 120 + stops * 150,
                   depart_time="%02d:%02d" % ((6 + h % 14 + i * 3) % 24, (h // 7) % 6 * 10),
                   arrive_time="%02d:%02d" % ((10 + h % 14 + i * 3) % 24, 5),
                   from_airport=origins[i % len(origins)], to_airport=dests[i % len(dests)],
                   via=["HKG"] if stops else [], airline_codes=[code], flight_numbers=[f"{code}{100 + i}"],
                   google_best=i == 0)
            for i, (name, code, stops) in enumerate([("Demo Air", "DA", 0), ("Sample Jet", "IT", 1),
                                                     ("Test Airways", "TA", 0)])
        ]
        return make_fare(pick_options(apply_filters(options, opts or {})), "https://www.google.com/travel/flights")


def make_provider(name, currency, language, adults, seed=""):
    if name == "google":
        return GoogleFlightsProvider(currency, language, adults)
    if name == "demo":
        return DemoProvider(currency, seed)
    raise ValueError(f"unknown provider: {name}")
