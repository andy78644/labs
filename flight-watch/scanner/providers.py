"""Fare sources. Each provider answers one question: the cheapest fare for a
given origin, destination and date pair."""

import hashlib
import math
from dataclasses import dataclass, asdict
from datetime import date


@dataclass
class Fare:
    price: int
    airline: str
    stops: int
    duration_min: int
    depart_time: str  # "HH:MM" local time of the first leg
    url: str

    def to_dict(self):
        return asdict(self)


class GoogleFlightsProvider:
    """Google Flights through the fast-flights scraper. No API key needed,
    but it is an unofficial interface: keep the request rate low."""

    name = "google"

    def __init__(self, currency, language, adults=1):
        from fast_flights import FlightQuery, Passengers, create_query, get_flights
        from fast_flights.exceptions import FlightsNotFound

        self._FlightQuery = FlightQuery
        self._Passengers = Passengers
        self._create_query = create_query
        self._get_flights = get_flights
        self._not_found = FlightsNotFound
        self.currency = currency
        self.language = language
        self.adults = adults

    def search(self, origin, dest, depart, ret=None, max_stops=None):
        legs = [self._FlightQuery(date=depart.isoformat(), from_airport=origin, to_airport=dest)]
        if ret:
            legs.append(self._FlightQuery(date=ret.isoformat(), from_airport=dest, to_airport=origin))
        query = self._create_query(
            flights=legs,
            trip="round-trip" if ret else "one-way",
            passengers=self._Passengers(adults=self.adults),
            currency=self.currency,
            language=self.language,
            max_stops=max_stops,
        )
        try:
            results = self._get_flights(query)
        except self._not_found:
            return None
        priced = [r for r in results if r.price and r.price > 0]
        if not priced:
            return None
        best = min(priced, key=lambda r: r.price)
        first = best.flights[0]
        return Fare(
            price=int(best.price),
            airline=" / ".join(best.airlines),
            stops=max(len(best.flights) - 1, 0),
            duration_min=sum(f.duration for f in best.flights),
            depart_time="%02d:%02d" % first.departure.time,
            url=query.url(),
        )


class DemoProvider:
    """Deterministic made-up fares for trying the pipeline offline. Prices
    wobble with the date and the scan time so drop alerts can be exercised."""

    name = "demo"

    def __init__(self, currency="TWD", seed=""):
        self.currency = currency
        self.seed = seed

    def search(self, origin, dest, depart, ret=None, max_stops=None):
        h = int(hashlib.sha256(f"{origin}{dest}{self.seed}".encode()).hexdigest(), 16)
        base = 6000 + h % 9000
        days_out = (depart - date.today()).days
        wobble = math.sin(depart.toordinal() / 3 + h % 7) * 0.18
        lead = 0.25 if days_out < 21 else 0.0
        price = int(round(base * (1 + wobble + lead) / 10) * 10)
        return Fare(
            price=price,
            airline="Demo Air",
            stops=0,
            duration_min=180 + h % 120,
            depart_time="%02d:%02d" % (6 + h % 14, (h // 7) % 6 * 10),
            url="https://www.google.com/travel/flights",
        )


def make_provider(name, currency, language, adults, seed=""):
    if name == "google":
        return GoogleFlightsProvider(currency, language, adults)
    if name == "demo":
        return DemoProvider(currency, seed)
    raise ValueError(f"unknown provider: {name}")
