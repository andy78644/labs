"""Fare sources. Each provider answers one question: the flight options for
given origin and destination airports and a date pair, cheapest first."""

import base64
import hashlib
import math
from dataclasses import dataclass, asdict, field
from datetime import date

MAX_OPTIONS = 6


@dataclass
class Option:
    price: int
    airline: str
    stops: int
    duration_min: int
    depart_time: str   # "HH:MM" local time of the first leg
    arrive_time: str   # "HH:MM", with "+1" when it lands the next day
    from_airport: str
    to_airport: str
    via: list = field(default_factory=list)


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

    def to_dict(self):
        return asdict(self)


def pick_options(options, limit=MAX_OPTIONS):
    """Cheapest first, one per airline/departure time, and always keep the
    cheapest nonstop and the fastest flight if they would be cut."""
    options = sorted(options, key=lambda o: (o.price, o.duration_min))
    seen, picked = set(), []
    for o in options:
        k = (o.airline, o.depart_time, o.stops)
        if k not in seen:
            seen.add(k)
            picked.append(o)
    keep = picked[:limit]
    extras = [
        next((o for o in picked if o.stops == 0), None),
        min(picked, key=lambda o: o.duration_min) if picked else None,
    ]
    for e in extras:
        if e is not None and e not in keep:
            keep = keep[:-1] + [e] if len(keep) >= limit else keep + [e]
    return sorted(keep, key=lambda o: (o.price, o.duration_min))


def make_fare(options, url):
    if not options:
        return None
    best = options[0]
    return Fare(
        price=best.price, airline=best.airline, stops=best.stops, duration_min=best.duration_min,
        depart_time=best.depart_time, url=url, options=[asdict(o) for o in options],
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


class GoogleFlightsProvider:
    """Google Flights through the fast-flights scraper. No API key needed,
    but it is an unofficial interface: keep the request rate low."""

    name = "google"
    URL = "https://www.google.com/travel/flights"

    def __init__(self, currency, language, adults=1):
        from fast_flights import FlightQuery, Passengers, create_query
        from fast_flights.exceptions import FlightsNotFound
        from fast_flights.parser import parse
        from fast_flights.pb.flights_pb2 import Airport
        from primp import Client

        self._FlightQuery = FlightQuery
        self._Passengers = Passengers
        self._create_query = create_query
        self._parse = parse
        self._Airport = Airport
        self._not_found = FlightsNotFound
        self._client = Client(impersonate="chrome_145", impersonate_os="macos", referer=True, cookie_store=True)
        self.currency = currency
        self.language = language
        self.adults = adults

    def _tfs(self, origins, dests, depart, ret, max_stops):
        """fast-flights encodes one airport per leg. Google's own format repeats
        the airport fields (13 = from, 14 = to), so extra airports are appended."""
        legs = [(depart, origins, dests)] + ([(ret, dests, origins)] if ret else [])
        query = self._create_query(
            flights=[self._FlightQuery(date=d.isoformat(), from_airport=f[0], to_airport=t[0]) for d, f, t in legs],
            trip="round-trip" if ret else "one-way",
            passengers=self._Passengers(adults=self.adults),
            currency=self.currency,
            language=self.language,
            max_stops=max_stops,
        )
        info = query.pb()
        datas = list(info.data)
        del info.data[:]
        out = info.SerializeToString()
        for fd, (_, f, t) in zip(datas, legs):
            b = fd.SerializeToString()
            b += b"".join(_field(13, self._Airport(airport=a).SerializeToString()) for a in f[1:])
            b += b"".join(_field(14, self._Airport(airport=a).SerializeToString()) for a in t[1:])
            out += _field(3, b)
        return base64.b64encode(out).decode()

    def search(self, origins, dests, depart, ret=None, max_stops=None):
        tfs = self._tfs(origins, dests, depart, ret, max_stops)
        params = {"tfs": tfs, "hl": self.language, "curr": self.currency}
        url = f"{self.URL}/search?tfs={tfs}&hl={self.language}&curr={self.currency}"
        html = self._client.get(self.URL, params=params).text
        try:
            results = self._parse(html)
        except self._not_found:
            return None
        options = []
        for r in results:
            if not r.price or r.price <= 0 or not r.flights:
                continue
            first, last = r.flights[0], r.flights[-1]
            arrive = "%02d:%02d" % last.arrival.time
            days = (date(*last.arrival.date) - date(*first.departure.date)).days
            if days > 0:
                arrive += f"+{days}"
            options.append(Option(
                price=int(r.price),
                airline=" / ".join(r.airlines),
                stops=len(r.flights) - 1,
                duration_min=sum(f.duration for f in r.flights),
                depart_time="%02d:%02d" % first.departure.time,
                arrive_time=arrive,
                from_airport=first.from_airport.code,
                to_airport=last.to_airport.code,
                via=[f.to_airport.code for f in r.flights[:-1]],
            ))
        return make_fare(pick_options(options), url)


class DemoProvider:
    """Deterministic made-up fares for trying the pipeline offline."""

    name = "demo"

    def __init__(self, currency="TWD", seed=""):
        self.currency = currency
        self.seed = seed

    def search(self, origins, dests, depart, ret=None, max_stops=None):
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
                   via=["HKG"] if stops else [])
            for i, (name, stops) in enumerate([("Demo Air", 0), ("Sample Jet", 1), ("Test Airways", 0)])
        ]
        return make_fare(pick_options(options), "https://www.google.com/travel/flights")


def make_provider(name, currency, language, adults, seed=""):
    if name == "google":
        return GoogleFlightsProvider(currency, language, adults)
    if name == "demo":
        return DemoProvider(currency, seed)
    raise ValueError(f"unknown provider: {name}")
