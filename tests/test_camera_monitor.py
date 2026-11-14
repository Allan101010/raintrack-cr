import importlib.util
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "monitor_cameras.py"
spec = importlib.util.spec_from_file_location("raintrack_camera_monitor", MODULE_PATH)
cams = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cams)

# Límites aproximados de Costa Rica (con margen para referencias fronterizas).
CR_LAT = (7.9, 11.3)
CR_LON = (-86.1, -82.4)


class ParsingTests(unittest.TestCase):
    def test_localized_numbers(self):
        self.assertEqual(cams.parse_localized_number("1.234,5"), 1234.5)
        self.assertEqual(cams.parse_localized_number("1,234.5"), 1234.5)
        self.assertEqual(cams.parse_localized_number("12,5"), 12.5)
        self.assertEqual(cams.parse_localized_number(" 7 "), 7.0)
        self.assertIsNone(cams.parse_localized_number(""))
        self.assertIsNone(cams.parse_localized_number(None))
        self.assertIsNone(cams.parse_localized_number("n/d"))

    def test_camera_name_from_slug(self):
        self.assertEqual(cams.camera_name_from_slug("tamarindo", "tamarindo-diria-1"), "Diriá 1")
        self.assertEqual(cams.camera_name_from_slug("tamarindo", "default"), "Vista general del sitio")

    def test_cache_busted_keeps_existing_query(self):
        url = cams.cache_busted("https://example.test/a.jpg?x=1")
        self.assertIn("x=1", url)
        self.assertIn("raintrack_ts=", url)


class StationFreshnessTests(unittest.TestCase):
    NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)

    def status(self, minutes_ago):
        stamp = (self.NOW - timedelta(minutes=minutes_ago)).isoformat()
        with patch.object(cams, "utc_now", return_value=self.NOW):
            return cams.assess_station_freshness(stamp)["availability_status"]

    def test_online_delayed_stale(self):
        self.assertEqual(self.status(5), "online")
        self.assertEqual(self.status(25), "online")  # el IMN publica ~cada 15 min + el ciclo del bot
        self.assertEqual(self.status(35), "delayed")
        self.assertEqual(self.status(40), "delayed")
        self.assertEqual(self.status(300), "stale")

    def test_future_or_missing_timestamp_is_unknown(self):
        with patch.object(cams, "utc_now", return_value=self.NOW):
            future = (self.NOW + timedelta(hours=3)).isoformat()
            self.assertEqual(cams.assess_station_freshness(future)["availability_status"], "unknown")
            self.assertEqual(cams.assess_station_freshness(None)["availability_status"], "unknown")
            self.assertEqual(cams.assess_station_freshness("no-es-fecha")["availability_status"], "unknown")


class StationHistoryTests(unittest.TestCase):
    def test_dead_after_seven_days_and_recovers(self):
        old = (cams.utc_now() - timedelta(days=8)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        previous = {"a": {"id": "a", "last_ok_at": old, "first_seen_at": old},
                    "b": {"id": "b", "last_ok_at": old, "first_seen_at": old}}
        rows = [{"id": "a", "availability_status": "stale"}, {"id": "b", "availability_status": "online"},
                {"id": "c", "availability_status": "stale"}]
        cams.apply_station_history(rows, previous)
        self.assertTrue(rows[0]["dead"])
        self.assertFalse(rows[1]["dead"])
        self.assertFalse(rows[2]["dead"])


class UcrVantageTests(unittest.TestCase):
    def test_parse_morning_and_afternoon(self):
        html = "Actualizado cada 5 minutos: 14/11/26, 7:01a Temperature 20.5&nbsp;°C Humidity 98% Today's Rain 1.2&nbsp;mm Rain Rate 2.4&nbsp;mm/hr"
        values = cams.parse_ucr_vantage(html)
        self.assertEqual(values["image_timestamp"], "2026-11-14T13:01:00Z")
        self.assertEqual(values["rain_rate_mmh"], 2.4)
        self.assertEqual(values["rain_today_mm"], 1.2)
        self.assertEqual(values["temperature_c"], 20.5)
        afternoon = cams.parse_ucr_vantage("Actualizado: 14/11/26, 1:05p Rain Rate 0.0 mm/hr")
        self.assertEqual(afternoon["image_timestamp"], "2026-11-14T19:05:00Z")


class CameraSourcesTests(unittest.TestCase):
    def test_config_file_matches_loaded_constants(self):
        raw = json.loads(cams.CAMERA_SOURCES_PATH.read_text(encoding="utf-8"))
        self.assertEqual(len(raw["sites"]), len(cams.SITES))
        self.assertEqual(len(raw["imn_stations"]), len(cams.IMN_STATIONS))

    def test_ids_are_unique(self):
        for name in ("IMN_STATIONS", "OVSICORI_CAMERAS", "SKYLINE_CAMERAS", "EXTERNAL_LINK_CAMERAS"):
            ids = [row["id"] for row in getattr(cams, name)]
            self.assertEqual(len(ids), len(set(ids)), name)
        slugs = [row[0] for row in cams.SITES]
        self.assertEqual(len(slugs), len(set(slugs)))

    def test_coordinates_are_inside_costa_rica(self):
        points = [(row[3], row[4], row[0]) for row in cams.SITES]
        for name in ("IMN_STATIONS", "OVSICORI_CAMERAS", "SKYLINE_CAMERAS", "EXTERNAL_LINK_CAMERAS"):
            points += [(row["lat"], row["lon"], row["id"]) for row in getattr(cams, name)]
        for lat, lon, label in points:
            self.assertTrue(CR_LAT[0] <= lat <= CR_LAT[1], f"lat fuera de rango: {label}")
            self.assertTrue(CR_LON[0] <= lon <= CR_LON[1], f"lon fuera de rango: {label}")

    def test_external_cameras_have_https_page_urls(self):
        for name in ("OVSICORI_CAMERAS", "SKYLINE_CAMERAS", "EXTERNAL_LINK_CAMERAS"):
            for row in getattr(cams, name):
                self.assertTrue(row["page_url"].startswith("https://"), row["id"])


if __name__ == "__main__":
    unittest.main()
