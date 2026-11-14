#!/usr/bin/env python3
"""
RainTrack CR - monitor visual de cámaras públicas de Costa Rica.

Descubre las cámaras de cada ficha de Webcams Costa Rica, obtiene las
capturas públicas disponibles y clasifica la escena con un modelo abierto
de condiciones meteorológicas. No intenta acceder a cámaras privadas ni
extraer vídeo de plataformas externas.

El análisis es orientativo: "rain/storm" es una clase del modelo, no una medición ni una probabilidad meteorológica calibrada.
Una cámara por sí sola nunca confirma lluvia; los registros instrumentales se informan por separado.
"""

from __future__ import annotations

import io
import json
import logging
import re
import statistics
import time
import unicodedata
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageOps, ImageStat

try:
    from scripts.notify_zones import notify_new_rain
except ImportError:  # ejecución directa: python scripts/monitor_cameras.py
    from notify_zones import notify_new_rain

BASE_URL = "https://webcamscostarica.com/"
CATALOG_SCHEMA_VERSION = 5
CATALOG_PATH = Path("camera-catalog.json")
ALERTS_PATH = Path("camera-alerts.json")
CATALOG_MAX_AGE = timedelta(hours=6)
CAMERA_ONLINE_MAX_AGE = timedelta(minutes=20)
CAMERA_DELAYED_MAX_AGE = timedelta(hours=1)
HTTP_TIMEOUT = 25
USER_AGENT = "RainTrackCR/1.5 (public weather-camera monitor; +https://github.com/Allan101010/RAINROAD)"
MAX_IMAGE_BYTES = 18 * 1024 * 1024

# Listas de cámaras y estaciones: viven en config/camera-sources.json.
# Las coordenadas son referencias de localidad o punto de interés, no la
# posición exacta de cada lente o sensor.
CAMERA_SOURCES_PATH = Path(__file__).resolve().parents[1] / "config" / "camera-sources.json"
_CAMERA_SOURCES = json.loads(CAMERA_SOURCES_PATH.read_text(encoding="utf-8"))
SITES = [tuple(row) for row in _CAMERA_SOURCES["sites"]]
IMN_STATIONS = _CAMERA_SOURCES["imn_stations"]
OVSICORI_CAMERAS = _CAMERA_SOURCES["ovsicori_cameras"]
SKYLINE_CAMERAS = _CAMERA_SOURCES["skyline_cameras"]
# Cámaras de video en vivo sin imagen fija pública: solo se enlazan, no se pueden verificar.
EXTERNAL_LINK_CAMERAS = _CAMERA_SOURCES.get("external_cameras", [])
CAMERA_NAME_OVERRIDES = _CAMERA_SOURCES["camera_name_overrides"]

OFFLINE_PHRASES = (
    "ahora no está emitiendo",
    "no está emitiendo ahora mismo",
    "no está enviando imágenes ahora",
    "esta cámara no está enviando imágenes",
    "no envía imágenes desde",
    "ahora no emite",
)

# No se excluye una cámara por su categoría o nombre. Todas son candidatas;
# un modelo visual independiente decide si el encuadre muestra suficiente
# entorno exterior para que el análisis meteorológico tenga sentido.
def is_weather_view(site_slug: str, camera_name: str) -> tuple[bool, str]:
    return True, "Candidata: la IA evaluará si el encuadre muestra entorno exterior útil para meteorología."


# Cámaras oficiales OVSICORI-UNA. Las coordenadas son referencias del volcán
# para el mapa, no la posición topográfica exacta de cada lente.


# Cámaras públicas de SkylineWebcams. Algunas fichas ofrecen un reproductor
# de vídeo en vivo, pero este monitor solo verifica la disponibilidad de la ficha
# y conserva una miniatura de previsualización; no captura ni analiza el flujo.
# Las coordenadas son referencias de localidad o punto de interés, no la
# posición exacta del lente: SkylineWebcams no publica coordenadas precisas.




def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def session_with_headers() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    return session


def get_page(session: requests.Session, url: str) -> tuple[str, str]:
    response = session.get(url, timeout=HTTP_TIMEOUT)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    return response.text, response.url


def text_content(soup: BeautifulSoup) -> str:
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True)).lower()


def page_is_offline(soup: BeautifulSoup) -> bool:
    text = text_content(soup)
    return any(phrase in text for phrase in OFFLINE_PHRASES)


def skyline_page_is_offline(soup: BeautifulSoup) -> bool:
    """Detect the explicit OFFLINE / OFF-LINE badge used by SkylineWebcams."""
    raw_text = soup.get_text(" ", strip=True)
    normalized = raw_text.casefold()
    return (
        bool(re.search(r"\b(?:offline|off-line)\b", raw_text, re.IGNORECASE))
        or "esta cámara no tiene conexión" in normalized
        or "esta camara no tiene conexion" in normalized
    )


def same_site_path(url_a: str, url_b: str) -> bool:
    a = urlparse(url_a)
    b = urlparse(url_b)
    return a.netloc == b.netloc and a.path.rstrip("/") == b.path.rstrip("/")


def is_group_camera_title(value: str) -> bool:
    """True when a heading describes a collection of cameras, not one camera."""
    return bool(re.search(r"\b(?:las?\s+)?(?:\d+\s+)?c[aá]maras?\s+de\b", value or "", re.IGNORECASE))


def camera_name_from_slug(site_slug: str, cam_slug: str) -> str:
    """Build a readable per-camera name when the provider repeats a group heading."""
    slug = cam_slug or ""
    prefix = site_slug + "-"
    if slug.startswith(prefix):
        slug = slug[len(prefix):]
    aliases = {"diria": "Diriá", "witchsrock": "Witch's Rock", "poas": "Poás", "irazu": "Irazú"}
    parts = []
    for part in slug.split("-"):
        if not part:
            continue
        parts.append(aliases.get(part.lower(), part if part.isdigit() else part.capitalize()))
    return " ".join(parts) if parts and slug != "default" else "Vista general del sitio"


def extract_camera_variants(
    session: requests.Session, page_url: str, soup: BeautifulSoup
) -> list[tuple[str, str, str]]:
    """Returns camera variants (slug, label, page URL) for a site."""
    variants: list[tuple[str, str, str]] = []
    seen: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href", "").strip()
        if "cam=" not in href:
            continue
        full_url = urljoin(page_url, href)
        if not same_site_path(full_url, page_url):
            continue
        cam_values = parse_qs(urlparse(full_url).query).get("cam", [])
        if not cam_values:
            continue
        cam_slug = cam_values[0].strip()
        if not cam_slug or cam_slug in seen:
            continue
        seen.add(cam_slug)
        label = anchor.get_text(" ", strip=True)
        label = re.sub(r"\s+", " ", label).strip()
        variants.append((cam_slug, label or cam_slug, full_url))

    if variants:
        # Algunas fichas muestran una cámara por defecto además de los enlaces
        # ?cam=. Se incorpora solo si el título no está ya representado.
        h2 = soup.find("h2")
        default_name = h2.get_text(" ", strip=True) if h2 else ""
        # No tratar el encabezado general "Las N cámaras de..." como una cámara extra.
        # Las variantes ?cam= ya representan las cámaras individuales del sitio.
        if default_name and not is_group_camera_title(default_name) and not any(
            default_name.lower() in label.lower() or label.lower() in default_name.lower()
            for _, label, _ in variants
        ):
            variants.insert(0, ("default", default_name, page_url))
        return variants

    h2 = soup.find("h2")
    name = h2.get_text(" ", strip=True) if h2 else ""
    if not name:
        h1 = soup.find("h1")
        name = h1.get_text(" ", strip=True) if h1 else "Cámara"
    return [("default", name, page_url)]


def snapshot_score(url: str, alt: str) -> int:
    parsed = urlparse(url)
    host_path = (parsed.netloc + parsed.path).lower()
    alt = (alt or "").lower()
    score = 0
    if "/snap/" in parsed.path.lower():
        score += 20
    if "ovsicori.una.ac.cr/images/stories/camaras/" in host_path and "camara" in host_path:
        score += 20
    if "meteo.unimore.it/meteo/ossgeo/" in host_path:
        score += 20
    if "phenocam" in host_path:
        score += 18
    if "cámara" in alt or "camara" in alt or "imagen en directo" in alt or "webcam" in alt:
        score += 8
    if "/assets/fotos/" in parsed.path.lower():
        score -= 25
    if any(ext in parsed.path.lower() for ext in (".jpg", ".jpeg", ".png", ".webp")):
        score += 2
    return score


def extract_snapshot_url(soup: BeautifulSoup, page_url: str) -> str | None:
    candidates: list[tuple[int, str]] = []

    for img in soup.find_all("img"):
        alt = img.get("alt", "")
        for attr in ("src", "data-src", "data-lazy-src"):
            raw = img.get(attr)
            if raw:
                full = urljoin(page_url, raw.strip())
                score = snapshot_score(full, alt)
                if score >= 10:
                    candidates.append((score, full))

        srcset = img.get("srcset")
        if srcset:
            first = srcset.split(",")[0].strip().split(" ")[0]
            full = urljoin(page_url, first)
            score = snapshot_score(full, alt)
            if score >= 10:
                candidates.append((score, full))

    for meta in soup.find_all("meta"):
        if meta.get("property") == "og:image" or meta.get("name") == "twitter:image":
            raw = meta.get("content")
            if raw:
                full = urljoin(page_url, raw.strip())
                score = snapshot_score(full, "camera snapshot")
                if score >= 15:
                    candidates.append((score, full))

    for video in soup.find_all("video"):
        raw = video.get("poster")
        if raw:
            full = urljoin(page_url, raw.strip())
            score = snapshot_score(full, "camera poster")
            if score >= 10:
                candidates.append((score, full))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def build_catalog(session: requests.Session) -> list[dict]:
    catalog: list[dict] = []

    for site_slug, site_name, zone, lat, lon in SITES:
        site_url = urljoin(BASE_URL, site_slug + "/")
        try:
            page_html, final_page_url = get_page(session, site_url)
            site_soup = BeautifulSoup(page_html, "html.parser")
            variants = extract_camera_variants(session, final_page_url, site_soup)
        except Exception as exc:
            logging.warning("No se pudo consultar %s: %s", site_name, exc)
            catalog.append({
                "id": site_slug + "-unavailable",
                "site_slug": site_slug,
                "site_name": site_name,
                "zone": zone,
                "lat": lat,
                "lon": lon,
                "camera_name": "Ficha no disponible",
                "page_url": site_url,
                "snapshot_url": None,
                "source_type": "webcamscostarica",
                "weather_relevant": True,
                "reason": "Ficha pendiente de revisión; se intentará recuperar la captura en cada ciclo.",
                "initial_status": "not_available",
            })
            continue

        for cam_slug, link_label, camera_page_url in variants:
            try:
                if camera_page_url == final_page_url:
                    camera_html, resolved_url, camera_soup = page_html, final_page_url, site_soup
                else:
                    camera_html, resolved_url = get_page(session, camera_page_url)
                    camera_soup = BeautifulSoup(camera_html, "html.parser")

                h2 = camera_soup.find("h2")
                camera_name = h2.get_text(" ", strip=True) if h2 else link_label
                if (
                    not camera_name
                    or camera_name.lower() in {"qué se ve", "qué se ve"}
                    or is_group_camera_title(camera_name)
                ):
                    candidate = (link_label or "").strip()
                    camera_name = candidate if candidate and not is_group_camera_title(candidate) else camera_name_from_slug(site_slug, cam_slug)
                camera_name = CAMERA_NAME_OVERRIDES.get(f"{site_slug}-{cam_slug}", camera_name)

                offline = page_is_offline(camera_soup)
                snapshot_url = extract_snapshot_url(camera_soup, resolved_url)
                weather_relevant, reason = is_weather_view(site_slug, camera_name)

                if offline:
                    initial_status = "offline"
                    snapshot_url = None
                elif not weather_relevant:
                    initial_status = "not_monitored"
                elif not snapshot_url:
                    initial_status = "not_available"
                    reason = "La ficha no expone una captura pública que pueda analizarse automáticamente."
                else:
                    initial_status = "pending"

                catalog.append({
                    "id": f"{site_slug}-{cam_slug}",
                    "site_slug": site_slug,
                    "site_name": site_name,
                    "zone": zone,
                    "lat": lat,
                    "lon": lon,
                    "camera_name": camera_name,
                    "page_url": resolved_url,
                    "snapshot_url": snapshot_url,
                    "source_type": "webcamscostarica",
                    "weather_relevant": True,
                    "reason": reason,
                    "initial_status": initial_status,
                })
                time.sleep(0.15)
            except Exception as exc:
                logging.warning("No se pudo leer cámara %s / %s: %s", site_name, link_label, exc)
                catalog.append({
                    "id": f"{site_slug}-{cam_slug}",
                    "site_slug": site_slug,
                    "site_name": site_name,
                    "zone": zone,
                    "lat": lat,
                    "lon": lon,
                    "camera_name": link_label or site_name,
                    "page_url": camera_page_url,
                    "snapshot_url": None,
                    "source_type": "webcamscostarica",
                    "weather_relevant": True,
                    "reason": "No se pudo consultar la cámara en esta revisión; se reintentará.",
                    "initial_status": "not_available",
                })

    # Añadir las ocho cámaras oficiales del OVSICORI-UNA.
    for camera in OVSICORI_CAMERAS:
        row = dict(camera)
        row.update({
            "weather_relevant": True,
            "reason": "Cámara exterior oficial OVSICORI-UNA; evaluación visual y control de antigüedad de imagen.",
            "initial_status": "pending",
        })
        catalog.append(row)

    # Añadir las diez cámaras de SkylineWebcams como fuente visual externa.
    # Solo se consulta el estado de su ficha; no se descargan sus imágenes para IA.
    for camera in SKYLINE_CAMERAS:
        row = dict(camera)
        row.update({
            "weather_relevant": False,
            "reason": (
                "La página original ofrece video en vivo, pero RainTrack solo muestra una miniatura "
                "y verifica la disponibilidad; todavía no reproduce ni analiza el flujo de video."
                if camera.get("live_video_page")
                else "Previsualización oficial de SkylineWebcams. Se verifica disponibilidad, pero no se utiliza para alertas automáticas de lluvia."
            ),
            "initial_status": "pending",
        })
        catalog.append(row)

    for camera in EXTERNAL_LINK_CAMERAS:
        row = dict(camera)
        row.update({
            "weather_relevant": False,
            "reason": camera.get("reason") or (
                "Esta cámara solo ofrece video en vivo en su página original. RainTrack no puede "
                "verificar si está en línea ni mostrar una miniatura; abre el enlace para verla."
            ),
            "initial_status": "pending",
        })
        catalog.append(row)

    # Evitar analizar varias veces la misma imagen repetida en distintas
    # variantes de una ficha. Se conserva la fuente oficial OVSICORI cuando
    # comparte la misma URL de imagen con una ficha agregadora.
    deduplicated: dict[tuple[str, str], dict] = {}
    without_snapshot: list[dict] = []
    for camera in catalog:
        snapshot = camera.get("snapshot_url")
        if not snapshot:
            without_snapshot.append(camera)
            continue
        parsed = urlparse(snapshot)
        normalized = urlunparse(parsed._replace(query="", fragment=""))
        key = (camera.get("site_slug", ""), normalized)
        existing = deduplicated.get(key)
        if existing is None or camera.get("source_type") == "ovsicori":
            deduplicated[key] = camera

    return list(deduplicated.values()) + without_snapshot


def load_catalog(session: requests.Session) -> list[dict]:
    if CATALOG_PATH.exists():
        try:
            saved = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
            generated_text = saved.get("generated_at") if isinstance(saved, dict) else None
            saved_cameras = saved.get("cameras", []) if isinstance(saved, dict) else saved
            schema_version = saved.get("schema_version", 0) if isinstance(saved, dict) else 0
            required_ovsicori = {camera["id"] for camera in OVSICORI_CAMERAS}
            present_ovsicori = {
                camera.get("id") for camera in saved_cameras
                if isinstance(camera, dict) and camera.get("source_type") == "ovsicori"
            }
            required_skyline = {camera["id"] for camera in SKYLINE_CAMERAS}
            present_skyline = {
                camera.get("id") for camera in saved_cameras
                if isinstance(camera, dict) and camera.get("source_type") == "skylinewebcams"
            }
            required_external = {camera["id"] for camera in EXTERNAL_LINK_CAMERAS}
            present_external = {
                camera.get("id") for camera in saved_cameras if isinstance(camera, dict)
            }
            if (
                generated_text and saved_cameras
                and required_external.issubset(present_external)
                and schema_version >= CATALOG_SCHEMA_VERSION
                and required_ovsicori.issubset(present_ovsicori)
                and required_skyline.issubset(present_skyline)
            ):
                generated = datetime.fromisoformat(generated_text.replace("Z", "+00:00"))
                age = datetime.now(timezone.utc) - generated
                if age < CATALOG_MAX_AGE:
                    return saved_cameras
        except Exception:
            pass

    logging.info("Actualizando catálogo de cámaras desde Webcams Costa Rica…")
    catalog = build_catalog(session)
    if catalog:
        CATALOG_PATH.write_text(
            json.dumps(
                {
                    "schema_version": CATALOG_SCHEMA_VERSION,
                    "generated_at": iso_now(),
                    "cameras": catalog,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return catalog

    if CATALOG_PATH.exists():
        saved = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            return saved.get("cameras", [])
        return saved
    raise RuntimeError("No fue posible construir el catálogo de cámaras.")


def cache_busted(url: str) -> str:
    parts = urlparse(url)
    query = parse_qs(parts.query)
    query["raintrack_ts"] = [str(int(time.time()))]
    return urlunparse(parts._replace(query=urlencode(query, doseq=True)))


def fetch_snapshot(session: requests.Session, url: str) -> tuple[Image.Image, dict]:
    headers = {
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    candidates = [cache_busted(url)]
    if candidates[0] != url:
        candidates.append(url)

    last_error = None
    for candidate_url in candidates:
        try:
            response = session.get(candidate_url, timeout=HTTP_TIMEOUT, headers=headers)
            response.raise_for_status()

            content_type = response.headers.get("Content-Type", "").lower()
            if not content_type.startswith("image/"):
                raise ValueError(f"La fuente no devolvió una imagen ({content_type or 'tipo desconocido'}).")
            if len(response.content) > MAX_IMAGE_BYTES:
                raise ValueError("La captura supera el tamaño permitido.")

            image = Image.open(io.BytesIO(response.content))
            image = ImageOps.exif_transpose(image).convert("RGB")
            if image.width < 120 or image.height < 80:
                raise ValueError("La imagen recibida es demasiado pequeña para analizarla.")

            metadata = {
                "content_type": content_type,
                "last_modified": response.headers.get("Last-Modified"),
                "date_header": response.headers.get("Date"),
                "etag": response.headers.get("ETag"),
                "retrieved_url": candidate_url,
            }
            return image, metadata
        except Exception as exc:
            last_error = exc

    raise ValueError(f"No se pudo leer la imagen con ni sin parámetro anticaché: {last_error}")


def extract_embedded_timestamp(image: Image.Image, source_type: str | None = None) -> datetime | None:
    """Read camera-burned timestamps (especially OVSICORI) from image edges."""
    try:
        import pytesseract
    except Exception:
        return None

    width, height = image.size
    band = max(35, int(height * 0.14))
    if source_type == "imn_station":
        # Los paneles IMN imprimen la fecha dentro del encabezado y el texto
        # de actualización puede ocupar más de la franja superior.
        regions = [
            image,
            image.crop((0, 0, width, min(height, max(band, int(height * 0.28))))),
        ]
    else:
        regions = [
            image.crop((0, 0, width, min(height, band))),
            image.crop((0, max(0, height - band), width, height)),
        ]
    ocr_text = []
    for region in regions:
        gray = ImageOps.autocontrast(region.convert("L"))
        if gray.width < 1600:
            gray = gray.resize((gray.width * 2, gray.height * 2))
        configs = ("--psm 6", "--psm 11") if source_type == "imn_station" else ("--psm 6",)
        for config in configs:
            try:
                ocr_text.append(pytesseract.image_to_string(gray, config=config))
            except Exception:
                continue

    text = " ".join(ocr_text)
    iso_match = re.search(
        r"\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})\b",
        text,
    )
    if iso_match:
        try:
            values = [int(value) for value in iso_match.groups()]
            local_time = datetime(*values, tzinfo=timezone(timedelta(hours=-6)))
            if local_time <= utc_now() + timedelta(minutes=10):
                return local_time.astimezone(timezone.utc)
        except ValueError:
            pass

    spanish_match = re.search(
        r"\b(?:a las\s+)?(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?).{0,100}?(?:del\s+d[ií]a\s+)?(\d{1,2})/(\d{1,2})/(20\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if spanish_match:
        try:
            hour, minute, meridiem, day, month, year = spanish_match.groups()
            hour = int(hour)
            minute = int(minute)
            if meridiem.lower().startswith("p") and hour != 12:
                hour += 12
            elif meridiem.lower().startswith("a") and hour == 12:
                hour = 0
            local_time = datetime(
                int(year), int(month), int(day), hour, minute,
                tzinfo=timezone(timedelta(hours=-6)),
            )
            if local_time <= utc_now() + timedelta(minutes=10):
                return local_time.astimezone(timezone.utc)
        except ValueError:
            pass

    date_first_match = re.search(
        r"\b(\d{1,2})/(\d{1,2})/(20\d{2}).{0,100}?(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)",
        text,
        re.IGNORECASE,
    )
    if date_first_match:
        try:
            day, month, year, hour, minute, meridiem = date_first_match.groups()
            hour = int(hour)
            if meridiem.lower().startswith("p") and hour != 12:
                hour += 12
            elif meridiem.lower().startswith("a") and hour == 12:
                hour = 0
            local_time = datetime(
                int(year), int(month), int(day), hour, int(minute),
                tzinfo=timezone(timedelta(hours=-6)),
            )
            if local_time <= utc_now() + timedelta(minutes=10):
                return local_time.astimezone(timezone.utc)
        except ValueError:
            pass

    english_match = re.search(
        r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(20\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if english_match:
        try:
            month, day, hour, minute, second, year = english_match.groups()
            local_time = datetime.strptime(
                f"{month} {day} {hour}:{minute}:{second} {year}",
                "%b %d %H:%M:%S %Y",
            ).replace(tzinfo=timezone(timedelta(hours=-6)))
            if local_time <= utc_now() + timedelta(minutes=10):
                return local_time.astimezone(timezone.utc)
        except ValueError:
            pass
    return None


def parse_http_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def assess_image_freshness(camera: dict, image: Image.Image, metadata: dict) -> dict:
    embedded = extract_embedded_timestamp(image, camera.get("source_type")) if camera.get("source_type") in {"ovsicori", "imn_station"} else None
    http_timestamp = parse_http_timestamp(metadata.get("last_modified"))
    timestamp = embedded or http_timestamp
    timestamp_source = "embedded_ocr" if embedded else ("http_last_modified" if http_timestamp else "not_provided")

    if timestamp is None:
        return {
            "availability_status": "unknown",
            "image_age_minutes": None,
            "image_timestamp": None,
            "image_timestamp_source": timestamp_source,
        }

    age_seconds = max(0.0, (utc_now() - timestamp).total_seconds())
    age_minutes = round(age_seconds / 60.0, 1)
    online_limit = timedelta(minutes=20) if camera.get("source_type") == "imn_station" else CAMERA_ONLINE_MAX_AGE
    if age_seconds <= online_limit.total_seconds():
        availability = "online"
    elif age_seconds <= CAMERA_DELAYED_MAX_AGE.total_seconds():
        availability = "delayed"
    else:
        availability = "stale"

    return {
        "availability_status": availability,
        "image_age_minutes": age_minutes,
        "image_timestamp": timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "image_timestamp_source": timestamp_source,
    }


def assess_image_quality(image: Image.Image) -> dict:
    """Detect frames too dark, flat or noisy; grayscale infrared alone is allowed."""
    gray = ImageOps.grayscale(image).resize((96, 96))
    stats = ImageStat.Stat(gray)
    histogram = gray.histogram()
    total = max(1, sum(histogram))

    def percentile(fraction: float) -> int:
        target = total * fraction
        cumulative = 0
        for value, count in enumerate(histogram):
            cumulative += count
            if cumulative >= target:
                return value
        return 255

    mean_luma = float(stats.mean[0])
    contrast = float(stats.stddev[0])
    p10, p90 = percentile(0.10), percentile(0.90)
    tile_means = [
        float(ImageStat.Stat(gray.crop((x, y, x + 8, y + 8))).mean[0])
        for y in range(0, 96, 8)
        for x in range(0, 96, 8)
    ]
    tile_variation = statistics.pstdev(tile_means) if len(tile_means) > 1 else 0.0

    quality_status = "usable"
    quality_reason = "ok"
    if mean_luma < 23 and p90 < 58:
        quality_status, quality_reason = "low_visibility", "low_light"
    elif contrast < 27 and (p90 - p10) < 42 and tile_variation < 22:
        quality_status, quality_reason = "low_visibility", "interference_or_low_detail"
    elif contrast < 6.5 and (p90 - p10) < 16:
        quality_status, quality_reason = "low_visibility", "flat_or_blank_frame"

    return {
        "image_quality_status": quality_status,
        "image_quality_reason": quality_reason,
        "image_mean_luma": round(mean_luma, 2),
        "image_contrast": round(contrast, 2),
        "image_tile_variation": round(tile_variation, 2),
    }


def read_previous_payload() -> dict:
    if not ALERTS_PATH.exists():
        return {}
    try:
        data = json.loads(ALERTS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}




def parse_localized_number(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        text = re.sub(r"\s+", "", str(value)).replace("\u00a0", "")
        if not text:
            return None
        if "," in text and "." in text:
            if text.rfind(",") > text.rfind("."):
                text = text.replace(".", "").replace(",", ".")
            else:
                text = text.replace(",", "")
        elif "," in text:
            text = text.replace(",", ".")
        return float(text)
    except (TypeError, ValueError):
        return None





def normalize_imn_header(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", normalized.lower()).strip("_")


def parse_imn_local_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = re.sub(r"\s+", " ", value.strip().lower())
    text = text.replace("a. m.", "am").replace("p. m.", "pm")
    text = text.replace("a.m.", "am").replace("p.m.", "pm")
    text = text.replace("a. m", "am").replace("p. m", "pm")
    text = re.sub(r"\s+", " ", text)
    for fmt in ("%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %I:%M %p", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            local = datetime.strptime(text, fmt).replace(tzinfo=timezone(timedelta(hours=-6)))
            return local.astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def extract_imn_table_values(html: str) -> dict:
    """Read the IMN's accessible HTML observation tables instead of OCRing its PNG."""
    soup = BeautifulSoup(html, "html.parser")
    parsed_tables = []

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        for index, row in enumerate(rows):
            cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["th", "td"])]
            if not cells or normalize_imn_header(cells[0]) != "fecha":
                continue

            headers = [normalize_imn_header(cell) for cell in cells]
            data_row = None
            for candidate in rows[index + 1:]:
                values = [
                    cell.get_text(" ", strip=True)
                    for cell in candidate.find_all(["th", "td"])
                    if cell.get_text(" ", strip=True)
                ]
                if values and len(headers) > 1:
                    # Algunas tablas del IMN envuelven la fila en una sola celda;
                    # otras dejan celdas vacías o separan la fecha del resto.
                    raw = " ".join(values)
                    match = re.match(
                        r"^(\d{1,2}/\d{1,2}/\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?)?)\s+(.+)$",
                        raw,
                        re.IGNORECASE,
                    )
                    if match:
                        date_text, remainder = match.groups()
                        numeric_values = re.findall(
                            r"[-+]?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,]\d+)?",
                            remainder,
                        )
                        if len(numeric_values) >= len(headers) - 1:
                            values = [date_text] + numeric_values[:len(headers) - 1]
                if len(values) >= len(headers) and values[0]:
                    data_row = dict(zip(headers, values))
                    break
            if data_row:
                parsed_tables.append(data_row)
            break

    hourly_candidates = [row for row in parsed_tables if "lluvia" in row]
    hourly = next(
        (row for row in hourly_candidates if "temp" in row or "temperatura" in row),
        hourly_candidates[0] if hourly_candidates else {},
    )
    accumulated = next(
        (row for row in parsed_tables if "sum_lluv" in row or "lluv_ayer" in row),
        {},
    )
    current = next(
        (row for row in parsed_tables if any(key in row for key in ("hr", "velocidad", "direccion", "td"))),
        {},
    )
    if not current:
        current = next(
            (row for row in parsed_tables if "vmax" in row or "vpmax" in row),
            {},
        )

    timestamps = [
        parsed
        for parsed in (parse_imn_local_datetime(row.get("fecha")) for row in parsed_tables)
        if parsed is not None
    ]
    timestamp = max(timestamps) if timestamps else None
    table_debug = " || ".join(
        f"headers={','.join(row.keys())}; fecha={row.get('fecha', '')}"
        for row in parsed_tables[:5]
    )
    return {
        "image_timestamp": timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z") if timestamp else None,
        "image_timestamp_source": "imn_html_table" if timestamp else "not_provided",
        "rain_last_hour_mm": parse_localized_number(hourly.get("lluvia")),
        "rain_since_7am_mm": parse_localized_number(accumulated.get("sum_lluv")),
        "rain_previous_24h_mm": parse_localized_number(accumulated.get("lluv_ayer")),
        "temperature_c": parse_localized_number(current.get("temp")) or parse_localized_number(hourly.get("temp")),
        "humidity_percent": parse_localized_number(current.get("hr")),
        "wind_speed_kmh": parse_localized_number(current.get("velocidad")),
        "wind_direction_deg": parse_localized_number(current.get("direccion") or current.get("direction")),
        "wind_gust_kmh": parse_localized_number(current.get("vmax") or current.get("vpmax") or accumulated.get("vmax") or accumulated.get("vpmax")),
        "dew_point_c": parse_localized_number(current.get("td")),
        "pressure_hpa": parse_localized_number(hourly.get("p_atm") or hourly.get("pres_mb") or hourly.get("pres_atm") or current.get("p_atm") or current.get("pres_mb") or current.get("pres_atm")),
        "table_row_count": len(parsed_tables),
        "table_debug": table_debug,
        "data_source": "imn_html_table",
    }


def assess_station_freshness(timestamp_value: str | None) -> dict:
    if not timestamp_value:
        return {
            "availability_status": "unknown",
            "image_age_minutes": None,
        }
    try:
        timestamp = datetime.fromisoformat(timestamp_value.replace("Z", "+00:00"))
        age_seconds = (utc_now() - timestamp.astimezone(timezone.utc)).total_seconds()
        if age_seconds < -600:
            return {"availability_status": "unknown", "image_age_minutes": None}
        age_minutes = round(max(0.0, age_seconds) / 60.0, 1)
        if age_seconds <= timedelta(minutes=30).total_seconds():
            status = "online"
        elif age_seconds <= timedelta(hours=1).total_seconds():
            status = "delayed"
        else:
            status = "stale"
        return {"availability_status": status, "image_age_minutes": age_minutes}
    except (TypeError, ValueError):
        return {"availability_status": "unknown", "image_age_minutes": None}


def fetch_imn_table(session: requests.Session, url: str) -> dict:
    response = session.get(
        url,
        timeout=HTTP_TIMEOUT,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    response.raise_for_status()
    if len(response.content) > 3 * 1024 * 1024:
        raise ValueError("La tabla meteorológica supera el tamaño permitido.")
    try:
        html = response.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        html = response.text
    values = extract_imn_table_values(html)
    if not values.get("table_row_count"):
        raise ValueError("La página del IMN no contiene tablas de observaciones reconocibles.")
    return values


def extract_imn_station_values(image: Image.Image) -> dict:
    """Extract the numerical readings printed in official IMN station panels."""
    try:
        import pytesseract
        text = pytesseract.image_to_string(image, config="--psm 6")
    except Exception as exc:
        return {"ocr_error": str(exc)}

    compact = re.sub(r"\s+", " ", text)
    patterns = {
        "rain_last_hour_mm": r"(?:pre)?cip\w*.*?ultim\w*\s+hor\w*.*?([0-9]+(?:[.,][0-9]+)?)",
        "rain_since_7am_mm": r"lluvia.*?acumulad\w*.*?7\s*a\.?m\.?\s*.*?([0-9]+(?:[.,][0-9]+)?)",
        "rain_previous_24h_mm": r"de\s+7\s*a\.?m\.?\s+de\s+ayer.*?7\s*a\.?m\.?\s+de\s+hoy.*?([0-9]+(?:[.,][0-9]+)?)",
        "wind_speed_kmh": r"velocid\w*.*?([0-9]+(?:[.,][0-9]+)?)\s*km/?h",
        "temperature_c": r"temper\w*.*?([0-9]+(?:[.,][0-9]+)?)\s*°?\s*c",
        "humidity_percent": r"hum\w*.*?([0-9]+(?:[.,][0-9]+)?)\s*%",
        "pressure_hpa": r"pres\w*.*?([0-9]+(?:[.,][0-9]+)?)\s*hpa",
    }
    values = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, compact, re.IGNORECASE)
        values[key] = parse_localized_number(match.group(1)) if match else None

    # Fallbacks conservadores cuando el OCR confunde las etiquetas, pero
    # conserva la unidad junto al número.
    if values["wind_speed_kmh"] is None:
        match = re.search(r"([0-9]+(?:[.,][0-9]+)?)\s*km/?h", compact, re.IGNORECASE)
        values["wind_speed_kmh"] = parse_localized_number(match.group(1)) if match else None
    if values["temperature_c"] is None:
        matches = re.findall(r"([0-9]{1,2}(?:[.,][0-9]+)?)\s*°?\s*c\b", compact, re.IGNORECASE)
        plausible = [parse_localized_number(value) for value in matches]
        plausible = [value for value in plausible if value is not None and -5 <= value <= 50]
        values["temperature_c"] = plausible[0] if plausible else None
    if values["humidity_percent"] is None:
        matches = re.findall(r"([0-9]{1,3})\s*%", compact)
        plausible = [int(value) for value in matches if 0 <= int(value) <= 100]
        values["humidity_percent"] = plausible[0] if plausible else None

    values["ocr_excerpt"] = compact[:1500]
    return values


DEAD_STATION_DAYS = 7


def apply_station_history(stations: list[dict], previous_stations: dict) -> None:
    """Lleva la cuenta de cuándo transmitió cada estación por última vez.

    Una estación que pasa más de DEAD_STATION_DAYS sin una lectura reciente se marca
    como `dead` (la app la oculta) y vuelve sola en cuanto transmita de nuevo.
    """
    now = utc_now()
    for station in stations:
        previous = previous_stations.get(station.get("id"), {})
        if station.get("availability_status") in {"online", "delayed"}:
            station["last_ok_at"] = iso_now()
        else:
            station["last_ok_at"] = previous.get("last_ok_at") or previous.get("first_seen_at")
        station["first_seen_at"] = previous.get("first_seen_at") or iso_now()
        reference = station.get("last_ok_at") or station["first_seen_at"]
        try:
            since = datetime.fromisoformat(reference.replace("Z", "+00:00"))
            station["dead"] = (now - since.astimezone(timezone.utc)) > timedelta(days=DEAD_STATION_DAYS)
        except (TypeError, ValueError):
            station["dead"] = False


def collect_imn_stations(session: requests.Session) -> list[dict]:
    stations = []
    for station in IMN_STATIONS:
        result = {
            "id": station["id"],
            "station_name": station["station_name"],
            "zone": station["zone"],
            "lat": station["lat"],
            "lon": station["lon"],
            "coordinate_note": station.get("coordinate_note"),
            "page_url": station.get("page_url") or station["table_url"],
            "source_url": station.get("table_url") or station["snapshot_url"],
            "table_url": station.get("table_url"),
            "snapshot_url": station["snapshot_url"],
            "source_type": "imn_station",
            "data_source": "imn_html_table",
            "status": "not_available",
            "availability_status": "not_available",
            "checked_at": iso_now(),
            "image_timestamp": None,
            "image_age_minutes": None,
            "image_timestamp_source": "not_provided",
            "rain_last_hour_mm": None,
            "rain_since_7am_mm": None,
            "rain_previous_24h_mm": None,
            "wind_speed_kmh": None,
            "wind_direction_deg": None,
            "wind_gust_kmh": None,
            "dew_point_c": None,
            "temperature_c": None,
            "humidity_percent": None,
            "pressure_hpa": None,
            "rain_observed": False,
        }
        try:
            table_values = fetch_imn_table(session, station["table_url"])
            result.update(table_values)
            result.update(assess_station_freshness(result.get("image_timestamp")))
            result["status"] = result["availability_status"]
            rain_amount = result.get("rain_last_hour_mm")
            result["rain_observed"] = (
                rain_amount is not None
                and rain_amount > 0
                and result["availability_status"] == "online"
                and result.get("image_timestamp_source") == "imn_html_table"
            )
            if result["availability_status"] == "stale":
                result["message"] = "La tabla del IMN está accesible, pero su última observación tiene más de una hora."
            elif result["availability_status"] == "delayed":
                result["message"] = "La observación del IMN tiene entre 30 y 60 minutos; no se usa para alertas inmediatas."
            elif result["availability_status"] == "unknown":
                result["message"] = "La tabla está accesible, pero no se pudo verificar la hora de observación."
            else:
                result["message"] = "Lectura instrumental reciente obtenida directamente de la tabla HTML del IMN."
            logging.info(
                "IMN %s tabla: filas=%s detalle=%s hora=%s lluvia_hora=%s lluvia_7am=%s temperatura=%s viento=%s humedad=%s estado=%s",
                station["id"],
                result.get("table_row_count"),
                result.get("table_debug"),
                result.get("image_timestamp"),
                result.get("rain_last_hour_mm"),
                result.get("rain_since_7am_mm"),
                result.get("temperature_c"),
                result.get("wind_speed_kmh"),
                result.get("humidity_percent"),
                result.get("availability_status"),
            )
            result.pop("table_debug", None)
        except Exception as exc:
            result["status"] = "offline"
            result["availability_status"] = "offline"
            result["data_source"] = "imn_html_table_unavailable"
            result["message"] = f"No se pudo obtener la tabla de observaciones del IMN: {exc}"
            logging.warning("IMN %s: %s", station["id"], result["message"])
        stations.append(result)
    return stations


UCR_BASE = "https://tooji.cigefi.ucr.ac.cr/estaciones/"
UCR_STATIONS = [
    {"id": "ucr-sanramon", "station_name": "Estación UCR · Sede Occidente (San Ramón)", "zone": "Valle Central Oeste",
     "lat": 10.0877, "lon": -84.4730, "path": "SanRamon/Current_Vantage_Pro_Plus.htm"},
    {"id": "ucr-piro", "station_name": "Estación UCR · Piro (Osa)", "zone": "Pacífico Sur",
     "lat": 8.4200, "lon": -83.3200, "path": "Piro/Current_Vantage_Pro_Plus.htm"},
    {"id": "ucr-siquirres", "station_name": "Estación UCR · Siquirres", "zone": "Caribe",
     "lat": 10.0975, "lon": -83.5075, "path": "Siquirres/Current_Vantage_Pro_Plus.htm"},
]


def parse_ucr_vantage(html_text: str) -> dict:
    """Extrae hora local (UTC-6), lluvia y variables de la página 'Condiciones actuales' de la UCR."""
    import html as _html
    text = _html.unescape(re.sub(r"<[^>]+>", " ", html_text)).replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text)

    def number(pattern: str):
        match = re.search(pattern, text, re.IGNORECASE)
        return float(match.group(1)) if match else None

    stamp = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2}),?\s*(\d{1,2}):(\d{2})\s*([ap])?", text)
    timestamp = None
    if stamp:
        day, month, year, hour, minute, suffix = stamp.groups()
        hour = int(hour)
        if suffix == "p" and hour < 12:
            hour += 12
        elif suffix == "a" and hour == 12:
            hour = 0
        try:
            local = datetime(2000 + int(year), int(month), int(day), hour, int(minute), tzinfo=timezone(timedelta(hours=-6)))
            timestamp = local.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except ValueError:
            timestamp = None
    return {
        "image_timestamp": timestamp,
        "rain_rate_mmh": number(r"Rain Rate\s*([0-9]+(?:\.[0-9]+)?)"),
        "rain_today_mm": number(r"Today'?s Rain\s*([0-9]+(?:\.[0-9]+)?)"),
        "temperature_c": number(r"Temperature\s*(-?[0-9]+(?:\.[0-9]+)?)\s*°C"),
        "humidity_percent": number(r"Humidity\s*([0-9]+(?:\.[0-9]+)?)\s*%"),
        "pressure_hpa": number(r"Barometer\s*([0-9]+(?:\.[0-9]+)?)"),
    }


def collect_ucr_stations(session: requests.Session) -> list[dict]:
    """Estaciones de la UCR (CIGEFI) con lecturas cada 5 min. Solo cuentan si la hora de lectura es reciente."""
    rows = []
    for station in UCR_STATIONS:
        row = {
            "id": station["id"], "station_name": station["station_name"], "zone": station["zone"],
            "lat": station["lat"], "lon": station["lon"],
            "coordinate_note": "Ubicación aproximada de la localidad; no es la posición exacta del sensor.",
            "page_url": UCR_BASE + station["path"], "source_url": UCR_BASE + station["path"],
            "source_type": "ucr_station", "data_source": "ucr_cigefi_vantage",
            "status": "offline", "availability_status": "offline", "checked_at": iso_now(),
            "image_timestamp": None, "image_age_minutes": None, "image_timestamp_source": "not_provided",
            "rain_last_hour_mm": None, "rain_since_7am_mm": None, "rain_observed": False,
        }
        try:
            response = session.get(UCR_BASE + station["path"], timeout=HTTP_TIMEOUT)
            response.raise_for_status()
            values = parse_ucr_vantage(response.text)
            row.update({k: v for k, v in values.items() if k != "rain_rate_mmh"})
            row.update(assess_station_freshness(row.get("image_timestamp")))
            row["status"] = row["availability_status"]
            row["image_timestamp_source"] = "ucr_page" if row.get("image_timestamp") else "not_provided"
            rate = values.get("rain_rate_mmh")
            # La UCR publica intensidad instantánea (mm/h); se usa como estimación de la lluvia reciente.
            row["rain_last_hour_mm"] = rate if rate is not None and rate > 0 else (0.0 if rate is not None else None)
            row["rain_observed"] = bool(rate and rate > 0 and row["availability_status"] == "online")
            row["message"] = "Lectura de la estación de la UCR (CIGEFI), actualizada cada 5 min; la lluvia es la intensidad actual (mm/h)."
            logging.info("UCR %s hora=%s lluvia_mmh=%s hoy=%s estado=%s", station["id"], row.get("image_timestamp"), rate,
                         values.get("rain_today_mm"), row["availability_status"])
        except Exception as exc:
            row["message"] = f"No se pudo leer la estación de la UCR: {exc}"
            logging.warning("UCR %s: %s", station["id"], row["message"])
        rows.append(row)
    return rows


def status_signature(payload: dict) -> tuple:
    rows = payload.get("cameras", []) if isinstance(payload, dict) else []
    station_rows = payload.get("stations", []) if isinstance(payload, dict) else []
    camera_signature = tuple(sorted(
        (
            item.get("id"),
            item.get("status"),
            item.get("availability_status"),
            item.get("image_quality_status"),
        )
        for item in rows
        if item.get("id")
    ))
    station_signature = tuple(sorted(
        (
            item.get("id"),
            item.get("availability_status"),
            item.get("image_timestamp"),
            item.get("rain_last_hour_mm"),
            item.get("rain_since_7am_mm"),
            item.get("temperature_c"),
            item.get("wind_speed_kmh"),
            item.get("wind_direction_deg"),
            item.get("wind_gust_kmh"),
            item.get("dew_point_c"),
            item.get("humidity_percent"),
            item.get("pressure_hpa"),
        )
        for item in station_rows
        if item.get("id")
    ))
    return camera_signature + station_signature


def previous_publish_time(payload: dict) -> datetime | None:
    value = payload.get("generated_at") if isinstance(payload, dict) else None
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def resolve_snapshot_url(session: requests.Session, camera: dict) -> tuple[str | None, str | None]:
    snapshot_url = camera.get("snapshot_url")
    if snapshot_url:
        return snapshot_url, None

    page_url = camera.get("page_url")
    if not page_url:
        return None, "not_available"

    try:
        page_html, resolved_url = get_page(session, page_url)
        soup = BeautifulSoup(page_html, "html.parser")
        if page_is_offline(soup):
            return None, "offline"
        snapshot_url = extract_snapshot_url(soup, resolved_url)
        return (snapshot_url, None) if snapshot_url else (None, "not_available")
    except Exception as exc:
        logging.info("No se pudo recuperar la ficha %s: %s", camera.get("id"), exc)
        return None, "offline"


WEATHERLINK_NEOJACO_ID = "893d2aa1a69d47928c05b4c1c8e1b6c0"


def fetch_weatherlink_station(session: requests.Session) -> dict:
    """Lee el JSON público del panel WeatherLink de NEOJACO (no requiere token)."""
    result = {
        "id": "ppv-neojaco",
        "station_name": "NEOJACO · WeatherLink",
        "zone": "Pacífico Central",
        "source_type": "weatherlink_station",
        "availability_status": "offline",
        "image_timestamp": None,
        "image_age_minutes": None,
        "rain_observed": False,
        "checked_at": iso_now(),
    }
    try:
        response = session.get(
            f"https://www.weatherlink.com/embeddablePage/getData/{WEATHERLINK_NEOJACO_ID}",
            timeout=HTTP_TIMEOUT,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        data = response.json()
        received = data.get("lastReceived")
        if received:
            stamp = datetime.fromtimestamp(int(received) / 1000, timezone.utc)
            result["image_timestamp"] = stamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")
            result.update(assess_station_freshness(result["image_timestamp"]))
        result["temperature_c"] = parse_localized_number(data.get("temperature"))
        result["humidity_percent"] = parse_localized_number(data.get("humidity"))
        result["wind_speed_kmh"] = parse_localized_number(data.get("wind"))
        result["rain_raw_mm"] = parse_localized_number(data.get("rain"))
        logging.info("NEOJACO WeatherLink: hora=%s estado=%s", result["image_timestamp"], result["availability_status"])
    except Exception as exc:
        logging.warning("NEOJACO WeatherLink no disponible: %s", exc)
    return result


def probe_ucr_js(session: requests.Session) -> None:
    """Sondeo temporal: registra de dónde cargan datos las páginas de la UCR."""
    import re as _re
    base = "https://tooji.cigefi.ucr.ac.cr/estaciones/"
    for path in ("powell/", "SanLuis/", "cr1000x/"):
        try:
            r = session.get(base + path, timeout=HTTP_TIMEOUT)
            html = r.text
            srcs = _re.findall(r"""<script[^>]+src=["']([^"']+)["']""", html)
            logging.info("UCRJS %s srcs=%s", path, srcs)
            for i, line in enumerate(html.splitlines()):
                if _re.search(r"fetch|XMLHttpRequest|axios|\.json|\.csv|\.php|api|http|url|endpoint|query|data/", line, _re.I):
                    logging.info("UCRJS %s L%03d %s", path, i, line.strip()[:260])
            for src in srcs:
                if src.startswith("http") and "tooji" not in src:
                    continue
                url = src if src.startswith("http") else base + path + src.lstrip("./")
                try:
                    js = session.get(url, timeout=HTTP_TIMEOUT).text
                    for i, line in enumerate(js.splitlines()):
                        if _re.search(r"fetch|XMLHttpRequest|\.json|\.csv|\.php|api|http|endpoint|url", line, _re.I):
                            logging.info("UCRJS %s %s L%03d %s", path, src[-30:], i, line.strip()[:260])
                except Exception as exc:
                    logging.info("UCRJS %s %s falló %s", path, src, exc)
        except Exception as exc:
            logging.info("UCRJS %s falló: %s", path, exc)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    session = session_with_headers()
    probe_ucr_js(session)
    catalog = load_catalog(session)
    previous_payload = read_previous_payload()
    previous_rows = {
        item.get("id"): item
        for item in previous_payload.get("cameras", [])
        if isinstance(item, dict) and item.get("id")
    }

    results: list[dict] = []

    for camera in catalog:
        result = {
            "id": camera["id"],
            "site_slug": camera["site_slug"],
            "site_name": camera["site_name"],
            "zone": camera["zone"],
            "lat": camera["lat"],
            "lon": camera["lon"],
            "camera_name": camera["camera_name"],
            "page_url": camera["page_url"],
            "preview_url": camera.get("snapshot_url") if camera.get("source_type") == "skylinewebcams" else None,
            "live_video_page": bool(camera.get("live_video_page", False)),
            "source_type": camera.get("source_type", "webcamscostarica"),
            "coordinate_note": camera.get("coordinate_note"),
            "status": "pending",
            "availability_status": "unknown",
            "image_quality_status": "pending",
            "image_quality_reason": "not_evaluated",
            "image_mean_luma": None,
            "image_contrast": None,
            "image_tile_variation": None,
            "message": camera.get("reason", ""),
            "checked_at": iso_now(),
            "image_last_modified": None,
            "image_age_minutes": None,
            "image_timestamp": None,
            "image_timestamp_source": "not_provided",
            "recovered": False,
        }

        if camera.get("source_type") == "external_link":
            result["image_quality_status"] = "not_evaluated"
            result["status"] = "external_link"
            result["message"] = camera.get("reason", "")
            results.append(result)
            continue

        if camera.get("source_type") == "skylinewebcams":
            try:
                page_html, resolved_url = get_page(session, camera["page_url"])
                page_soup = BeautifulSoup(page_html, "html.parser")
                result["page_url"] = resolved_url
                result["checked_at"] = iso_now()
                result["image_quality_status"] = "not_evaluated"
                if skyline_page_is_offline(page_soup):
                    result["availability_status"] = "offline"
                    result["status"] = "offline"
                    result["message"] = (
                        "SkylineWebcams indica que esta cámara está fuera de línea. "
                        "No se muestra una captura anterior ni se genera una alerta."
                    )
                else:
                    result["availability_status"] = "online"
                    result["status"] = "external_preview"
                    result["message"] = (
                        "La ficha de SkylineWebcams está disponible. "
                        + (
                            "La página original ofrece un reproductor de video en vivo; RainTrack solo "
                            "muestra la miniatura y todavía no reproduce ni analiza el flujo."
                            if camera.get("live_video_page")
                            else "Se muestra su imagen oficial de previsualización; esta fuente no se analiza con IA."
                        )
                        + " No genera alertas automáticas de lluvia."
                    )
            except Exception as exc:
                result["availability_status"] = "unknown"
                result["status"] = "not_available"
                result["message"] = (
                    "No se pudo verificar la disponibilidad en SkylineWebcams. "
                    "No se muestra una captura anterior. Se volverá a comprobar en el siguiente ciclo."
                )
                logging.info("No se pudo verificar SkylineWebcams %s: %s", camera.get("id"), exc)
            results.append(result)
            continue

        snapshot_url, resolution_status = resolve_snapshot_url(session, camera)
        if not snapshot_url:
            result["availability_status"] = "offline" if resolution_status == "offline" else "not_available"
            result["status"] = "offline" if resolution_status == "offline" else "not_available"
            result["message"] = (
                "La cámara no está transmitiendo o su ficha indica que no emite."
                if resolution_status == "offline"
                else "No se encontró una imagen pública utilizable. Se volverá a comprobar en el siguiente ciclo."
            )
            results.append(result)
            continue

        try:
            image, metadata = fetch_snapshot(session, snapshot_url)
            result["image_last_modified"] = metadata.get("last_modified")
            result.update(assess_image_freshness(camera, image, metadata))
            result.update(assess_image_quality(image))

            if result["image_quality_status"] != "usable":
                result["status"] = "low_visibility"
                if result["image_quality_reason"] == "low_light":
                    result["message"] = (
                        "La imagen está demasiado oscura para evaluar lluvia. "
                        "Puede tratarse de una cámara sin visión nocturna; se excluye hasta que haya una captura clara."
                    )
                else:
                    result["message"] = (
                        "La imagen presenta interferencia, poco contraste o muy poco detalle. "
                        "No se toma en cuenta para lluvia hasta que la captura sea legible."
                    )
                results.append(result)
                continue

            if result["availability_status"] == "stale":
                result["status"] = "stale"
                result["message"] = (
                    "La imagen se puede descargar, pero su marca de tiempo indica que lleva más de una hora sin actualizarse. "
                    "No se usa para generar alertas actuales."
                )
                results.append(result)
                continue

            availability = result.get("availability_status")
            result["status"] = availability if availability in {"online", "delayed"} else "unknown"
            if availability == "online":
                result["message"] = (
                    "Imagen reciente y legible. RainTrack no analiza la lluvia en las cámaras: "
                    "la lluvia se informa solo con las estaciones del IMN."
                )
            elif availability == "delayed":
                result["message"] = "La imagen está demorada (entre 20 minutos y 1 hora)."
            else:
                result["message"] = "La fuente no publica una marca de tiempo verificable para esta imagen."
            results.append(result)
        except Exception as exc:
            result["availability_status"] = "offline"
            result["status"] = "offline"
            result["message"] = f"No se pudo obtener una imagen válida: {exc}"
            results.append(result)

    # Marcar explícitamente cámaras que regresaron después de estar caídas o desactualizadas.
    for result in results:
        previous = previous_rows.get(result.get("id"), {})
        previous_availability = previous.get("availability_status")
        current_availability = result.get("availability_status")
        if previous_availability in {"offline", "stale", "not_available"} and current_availability in {"online", "delayed", "unknown"}:
            result["recovered"] = True
            result["message"] = "La cámara volvió a proporcionar una imagen. " + result.get("message", "")

    results.sort(key=lambda item: (item.get("zone", ""), item.get("site_name", ""), item.get("camera_name", "")))

    # Estaciones IMN: lecturas instrumentales independientes del análisis visual.
    stations = collect_imn_stations(session)
    stations.extend(collect_ucr_stations(session))
    apply_station_history(stations, {item.get("id"): item for item in previous_payload.get("stations", []) if isinstance(item, dict)})
    external_stations = [fetch_weatherlink_station(session)]
    station_alerts = [
        {
            "alert_type": "station",
            "status": "rain",
            "station_id": station["id"],
            "station_name": station["station_name"],
            "site_name": station["station_name"],
            "camera_name": station["station_name"],
            "page_url": station["page_url"],
            "rain_last_hour_mm": station.get("rain_last_hour_mm"),
            "rain_since_7am_mm": station.get("rain_since_7am_mm"),
            "availability_status": station.get("availability_status"),
            "image_timestamp": station.get("image_timestamp"),
        }
        for station in stations
        if station.get("rain_observed")
    ]

    # Las cámaras ya no generan alertas de lluvia: solo las estaciones del IMN (station_alerts).
    alerts: list[dict] = []
    recovered_cameras = [item for item in results if item.get("recovered")]
    availability_counts = {
        state: sum(1 for item in results if item.get("availability_status") == state)
        for state in ("online", "delayed", "stale", "offline", "not_available", "unknown")
    }
    payload = {
        "status": "ok",
        "generated_at": iso_now(),
        "interval_minutes": 10,
        "source_url": BASE_URL,
        "sources": [
            {"name": "Webcams Costa Rica", "url": BASE_URL, "type": "public_webcams"},
            {"name": "SkylineWebcams", "url": "https://www.skylinewebcams.com/es/webcam/costa-rica.html", "type": "external_webcam_previews", "note": "Diez cámaras públicas. Algunas fichas, como el Aeropuerto de Cóbano, ofrecen video en vivo en la página original. RainTrack verifica la ficha y muestra una miniatura; no reproduce ni analiza el flujo de video ni genera alertas a partir de SkylineWebcams."},
            {"name": "OVSICORI-UNA", "url": "https://www.ovsicori.una.ac.cr/index.php/camaras", "type": "official_volcano_cameras"},
            {
                "name": "IMN · estaciones automáticas",
                "url": "https://www.imn.ac.cr/es/web/imn/estaciones-automaticas",
                "type": "official_station_observations",
                "note": "Se consultan 132 tablas HTML públicas de estaciones automáticas del IMN de todo el país; la ubicación de varias es aproximada. El IMN advierte que sus datos son preliminares y pueden retrasarse."
            },
            {
                "name": "Parapente Pura Vida",
                "url": "https://parapentepuravida.com/eltiempo/",
                "type": "methodology_reference",
                "note": "Se toma como referencia su triangulación por zona: estaciones, viento, satélite, pronóstico y cámaras. RainTrack consulta directamente las tablas del IMN cuando están disponibles y no depende de los embeds de terceros."
            },
            {
                "name": "NEOJACO · WeatherLink",
                "url": "https://www.weatherlink.com/embeddablePage/show/893d2aa1a69d47928c05b4c1c8e1b6c0/slim",
                "type": "external_station_widget",
                "note": "Panel público visible desde el marcador de Jacó; el bot lee su JSON público y solo lo usará si reporta datos de menos de 60 min; su última lectura es de nov-2025 (estación sin transmitir)."
            },
        ],
        "visual_rain_detection": "disabled",
        "model_note": (
            "Las cámaras muestran disponibilidad y frescura de la imagen; RainTrack no analiza la lluvia en ellas. "
            "La lluvia se informa solo con las mediciones instrumentales de las estaciones del IMN. "
            "Las imágenes oscuras, con interferencia o sin detalle se marcan como no legibles. "
            "Las cámaras SkylineWebcams son referencias visuales externas: se verifica su disponibilidad y se muestra una miniatura."
        ),
        "directory_sites": len(SITES) + len({camera["site_slug"] for camera in SKYLINE_CAMERAS}),
        "camera_count": len(results),
        "station_count": len(stations),
        "evaluated_count": sum(
            1 for item in results
            if item.get("image_quality_status") == "usable" and item.get("availability_status") == "online"
        ),
        "availability_counts": availability_counts,
        "station_availability_counts": {
            state: sum(1 for item in stations if item.get("availability_status") == state)
            for state in ("online", "delayed", "stale", "offline", "unknown", "not_available")
        },
        "alerts": alerts,
        "station_alerts": station_alerts,
        "recovered_cameras": recovered_cameras,
        "cameras": results,
        "stations": stations,
        "external_stations": external_stations,
    }

    notify_state = dict(previous_payload.get("notify_state") or {})
    sent = notify_new_rain(station_alerts, previous_payload.get("station_alerts", []), session, state=notify_state)
    payload["notify_state"] = notify_state
    if sent:
        logging.info("Avisos de lluvia enviados: %s.", sent)

    old_time = previous_publish_time(previous_payload)
    heartbeat_due = old_time is None or (utc_now() - old_time) >= timedelta(minutes=15)
    state_changed = status_signature(payload) != status_signature(previous_payload)

    if state_changed or heartbeat_due:
        ALERTS_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logging.info("Resultados publicados (cambio de estado o latido de 15 minutos).")
    else:
        logging.info("Sin cambios de estado; se conserva el último JSON publicado para evitar commits repetidos.")

    logging.info(
        "Monitor terminado: %s cámaras catalogadas, %s con imagen reciente, %s alertas de estaciones; disponibilidad=%s.",
        len(results),
        payload["evaluated_count"],
        len(station_alerts),
        availability_counts,
    )
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        logging.exception("Falló el monitor de cámaras: %s", exc)
        fallback = {
            "status": "error",
            "generated_at": iso_now(),
            "interval_minutes": 10,
            "source_url": BASE_URL,
            "camera_count": 0,
            "station_count": 0,
            "evaluated_count": 0,
            "alerts": [],
            "station_alerts": [],
            "cameras": [],
            "stations": [],
            "error": str(exc),
        }
        ALERTS_PATH.write_text(json.dumps(fallback, ensure_ascii=False, indent=2), encoding="utf-8")
        raise
