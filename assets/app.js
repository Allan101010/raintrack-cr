"use strict";

// ------------------------------------------------------------
// CONFIGURACIÓN GENERAL
// La última ubicación GPS se conserva localmente durante 30 minutos.
// ------------------------------------------------------------
const SOURCE_STORAGE_KEY = "raintrackcr_radar_source_v3"; // v3: la capa propia (RainTrack) es la principal por defecto
const LIBREWXR_COLOR_STORAGE_KEY = "raintrackcr_librewxr_color_v1";
const LOCATION_CACHE_KEY = "raintrackcr_current_location_v1";
const LOCATION_CACHE_TTL_MS = 30 * 60 * 1000;
const LOCATION_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000;
const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark"
};
const BASEMAP_STORAGE_KEY = "raintrackcr_basemap_v1";
let basemapMode = (() => { try { return localStorage.getItem(BASEMAP_STORAGE_KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; } })();
const MAP_STYLE = MAP_STYLES[basemapMode];
let lastRouteDraw = null;

// El mapa se limita a Costa Rica: permite acercar y alejar, pero no
// navegar libremente por el resto del mundo.
const CR_BOUNDARY_URL = "https://geojson-maps.kyd.au/countries/10m/CRI.geojson";
const CR_MAINLAND_BOUNDS = [[-85.98, 7.95], [-82.52, 11.25]];
const CR_NAVIGATION_BOUNDS = [[-86.25, 7.65], [-82.25, 11.55]];
const CR_MASK_COLOR = "#dce4e7";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";

// Ruta habitual: coordenadas de casa proporcionadas por el usuario.
// El destino laboral se configura una sola vez y se guarda localmente.
const ROUTE_HOME = {
  name: "Casa · Santa Rosa de Poás",
  lat: 10.102970,
  lon: -84.264296,
  detail: "Punto de origen guardado"
};
const ROUTE_WORK_STORAGE_KEY = "raintrackcr_saved_work_v1";
const OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving";
const ROUTE_WEATHER_SAMPLES_MAX = 8;

const RADAR_SOURCES = {
  librewxr: {
    type: "radar",
    label: "LibreWXR",
    metadataUrl: "https://api.librewxr.net/public/weather-maps.json",
    fallbackHost: "https://api.librewxr.net",
    maxZoom: 12,
    color: 10,
    smooth: 0,
    snow: 0
  }
};
const LIBREWXR_PALETTES = [1, 4, 8, 10, 14];

// Imágenes oficiales publicadas por el portal satelital del IMN.
// Se muestran como una vista flotante dentro del mismo mapa, no como
// una capa geográfica: no se dispone aquí de límites geográficos/teselas
// verificadas para alinearlas con calles y coordenadas.
const IMN_PRODUCTS = {
  irvis: {
    label: "Visible más infrarrojo",
    url: "https://imagenes.imn.ac.cr/img/IRVISCR.png",
    source: "https://www.imn.ac.cr/en/web/imn/imagenes-satelitalesl2"
  },
  lightning: {
    label: "Tormentas eléctricas",
    url: "https://imagenes.imn.ac.cr/img/VISRAYCR.png",
    source: "https://www.imn.ac.cr/en/web/imn/imagenes-satelitalesl2"
  },
  convection: {
    label: "Convección profunda",
    url: "https://imagenes.imn.ac.cr/img/DPCCR.png",
    source: "https://www.imn.ac.cr/en/web/imn/imagenes-satelitalesl2"
  },
  radargif: {
    label: "Radar animado IMN",
    url: "https://www.imn.ac.cr/imagenes-sat/radar1m-animada.gif",
    source: "https://www.imn.ac.cr/en/radar"
  }
};

// Cámaras públicas de Costa Rica. Los puntos son coordenadas de referencia
// del sitio o volcán, no necesariamente la posición exacta de cada lente.
// Los ocho feeds OVSICORI se agrupan en los volcanes ya presentes en el mapa.
const PUBLIC_CAMERAS = [
  { slug: "playa-flamingo", name: "Playa Flamingo", zone: "Guanacaste", lat: 10.4340, lon: -85.7860, url: "https://webcamscostarica.com/playa-flamingo/", detail: "Bahía y atardecer · 2 cámaras" },
  { slug: "playa-hermosa-guanacaste", name: "Playa Hermosa de Guanacaste", zone: "Guanacaste", lat: 10.5750, lon: -85.6770, url: "https://webcamscostarica.com/playa-hermosa-guanacaste/", detail: "Bahía de Papagayo · 1 cámara" },
  { slug: "playas-del-coco", name: "Playas del Coco", zone: "Guanacaste", lat: 10.5530, lon: -85.6940, url: "https://webcamscostarica.com/playas-del-coco/", detail: "Bahía de Playas del Coco · 1 cámara" },
  { slug: "tamarindo", name: "Tamarindo", zone: "Guanacaste", lat: 10.3000, lon: -85.8410, url: "https://webcamscostarica.com/tamarindo/", detail: "Playa y surf · 4 cámaras" },
  { slug: "volcan-rincon-de-la-vieja", name: "Volcán Rincón de la Vieja", zone: "Guanacaste", lat: 10.8300, lon: -85.3240, url: "https://webcamscostarica.com/volcan-rincon-de-la-vieja/", detail: "Imágenes del volcán · 3 cámaras" },
  { slug: "jaco", name: "Jacó", zone: "Pacífico Central", lat: 9.6140, lon: -84.6290, url: "https://webcamscostarica.com/jaco/", detail: "Playa y bahía · 3 cámaras" },
  { slug: "manuel-antonio", name: "Manuel Antonio", zone: "Pacífico Central", lat: 9.3920, lon: -84.1400, url: "https://webcamscostarica.com/manuel-antonio/", detail: "Playa Espadilla · 1 cámara" },
  { slug: "playa-herradura", name: "Playa Herradura", zone: "Pacífico Central", lat: 9.6600, lon: -84.6350, url: "https://webcamscostarica.com/playa-herradura/", detail: "Bahía de Herradura · 1 cámara" },
  { slug: "quepos", name: "Quepos", zone: "Pacífico Central", lat: 9.4050, lon: -84.1570, url: "https://webcamscostarica.com/quepos/", detail: "Bahía de Quepos · 1 cámara" },
  { slug: "punta-islita", name: "Lapas rojas de Punta Islita", zone: "Península de Nicoya", lat: 9.8530, lon: -85.3980, url: "https://webcamscostarica.com/punta-islita/", detail: "Cámaras exteriores de fauna · encuadre evaluado por IA" },
  { slug: "nosara", name: "Nosara", zone: "Península de Nicoya", lat: 9.9400, lon: -85.6650, url: "https://webcamscostarica.com/nosara/", detail: "Costa y surf · 1 cámara" },
  { slug: "reserva-karen-mogensen", name: "Reserva Karen Mogensen", zone: "Península de Nicoya", lat: 9.8690, lon: -85.0580, url: "https://webcamscostarica.com/reserva-karen-mogensen/", detail: "Bosque de la reserva · 1 cámara" },
  { slug: "santa-teresa", name: "Santa Teresa", zone: "Península de Nicoya", lat: 9.6460, lon: -85.1690, url: "https://webcamscostarica.com/santa-teresa/", detail: "Playa y surf · puede estar fuera de emisión" },
  { slug: "cartago", name: "Cartago", zone: "Valle Central", lat: 9.8640, lon: -83.9190, url: "https://webcamscostarica.com/cartago/", detail: "Panorámica de Cartago e Irazú · 1 cámara" },
  { slug: "cerros-de-escazu", name: "Cerros de Escazú", zone: "Valle Central", lat: 9.9040, lon: -84.1580, url: "https://webcamscostarica.com/cerros-de-escazu/", detail: "Cerro Bebedero · 1 cámara" },
  { slug: "san-jose", name: "San José", zone: "Valle Central", lat: 9.9330, lon: -84.0800, url: "https://webcamscostarica.com/san-jose/", detail: "Panorámica 4K · 1 cámara" },
  { slug: "toucan-rescue-ranch", name: "Toucan Rescue Ranch", zone: "Valle Central", lat: 10.0350, lon: -84.1000, url: "https://webcamscostarica.com/toucan-rescue-ranch/", detail: "Cámaras exteriores de fauna · encuadre evaluado por IA" },
  { slug: "volcan-irazu", name: "Volcán Irazú", zone: "Valle Central", lat: 9.9790, lon: -83.8520, url: "https://webcamscostarica.com/volcan-irazu/", detail: "Imagen del cráter · 1 cámara" },
  { slug: "volcan-poas", name: "Volcán Poás", zone: "Valle Central", lat: 10.1980, lon: -84.2310, url: "https://webcamscostarica.com/volcan-poas/", detail: "Cráter del Poás · imágenes del OVSICORI" },
  { slug: "sarapiqui", name: "Lapas verdes de Sarapiquí", zone: "Zona Norte", lat: 10.4560, lon: -84.0190, url: "https://webcamscostarica.com/sarapiqui/", detail: "Cámaras de fauna y dosel · encuadre evaluado por IA" },
  { slug: "puerto-moin", name: "Puerto de Moín", zone: "Caribe", lat: 10.0035, lon: -83.1560, url: "https://www.apmterminals.com/en/moin/e-services/truck-turn-times", detail: "APM Terminals · entrada de camiones · imagen cada pocos minutos" },
  { slug: "volcan-arenal", name: "Volcán Arenal", zone: "Zona Norte", lat: 10.4637, lon: -84.7032, url: "https://www.arenalobservatorylodge.com/es/camara-en-vivo/", detail: "Arenal Observatory Lodge · video en vivo en la fuente" },
  { slug: "volcan-turrialba", name: "Volcán Turrialba", zone: "Valle Central", lat: 10.0250, lon: -83.7670, url: "https://www.ovsicori.una.ac.cr/index.php/vulcanologia/camara-volcanes-2/camara-v-turrialba", detail: "OVSICORI-UNA · cámara del cráter" },
  { slug: "skyline-moravia-panorama-sj", name: "SkylineWebcams · Panorama de San José", zone: "Valle Central", lat: 9.9345, lon: -84.075, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/moravia/panorama-san-jose.html", detail: "Vista de San José desde Moravia · 1 cámara" },
  { slug: "skyline-moravia-irazu", name: "SkylineWebcams · Volcán Irazú", zone: "Valle Central", lat: 9.973, lon: -83.86, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/moravia/irazu.html", detail: "Vista del Irazú desde Moravia · 1 cámara" },
  { slug: "skyline-moravia-san-vicente", name: "SkylineWebcams · San Vicente de Moravia", zone: "Valle Central", lat: 9.96164, lon: -84.0488, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/moravia/san-vicente.html", detail: "San Vicente de Moravia · 1 cámara" },
  { slug: "skyline-moravia-braulio-carrillo", name: "SkylineWebcams · Braulio Carrillo", zone: "Valle Central", lat: 10.08, lon: -84.0, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/moravia/heredia-braulio-carrillo.html", detail: "Vista de Braulio Carrillo desde Moravia · 1 cámara" },
  { slug: "skyline-cerro-bebedero", name: "SkylineWebcams · Cerro Bebedero", zone: "Valle Central", lat: 9.907972, lon: -84.162667, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/moravia/panorama-san-jose-costa-rica.html", detail: "Panorama de San José · coordenada de referencia" },
  { slug: "skyline-bahia-salinas", name: "SkylineWebcams · Bahía Salinas", zone: "Guanacaste", lat: 11.0300, lon: -85.7172, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/guanacaste/la-cruz/bahia-salinas.html", detail: "Playa Nandel · Nandel Beach Resort" },
  { slug: "skyline-cobano", name: "SkylineWebcams · Aeropuerto de Cóbano", zone: "Península de Nicoya", lat: 9.69328, lon: -85.09104, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/puntarenas/puntarenas/cobano.html", detail: "Pistas del Aeropuerto de Cóbano" },
  { slug: "skyline-esterillos", name: "SkylineWebcams · Esterillos Este", zone: "Pacífico Central", lat: 9.52478, lon: -84.45324, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/puntarenas/puntarenas/costa-rica-puntarenas.html", detail: "Playa Esterillos Este · Alma del Pacífico" },
  { slug: "skyline-san-isidro", name: "SkylineWebcams · San Isidro", zone: "Zona Sur", lat: 9.3706, lon: -83.7046, url: "https://www.skylinewebcams.com/es/webcam/costa-rica/san-jose-province/perez-zeledon/san-isidro.html", detail: "Valle de San Isidro de El General" }
];

const PUBLIC_STATIONS = [
  { id: "imn-aranjuez", name: "Estación IMN · Aranjuez", zone: "Valle Central", lat: 9.937944, lon: -84.069722, url: "https://www.imn.ac.cr/especial/estacion.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/imn.html", coordinateNote: "Coordenadas de referencia del producto público del IMN." },
  { id: "imn-volcan-turrialba", name: "Estación IMN · Volcán Turrialba", zone: "Valle Central", lat: 10.019167, lon: -83.756389, url: "https://www.imn.ac.cr/especial/estacionVturri.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/vturri.html", coordinateNote: "Coordenada de referencia del volcán; no necesariamente la posición exacta del sensor." },
  { id: "imn-quepos", name: "Estación IMN · Quepos", zone: "Pacífico Central", lat: 9.4310, lon: -84.1610, url: "https://www.imn.ac.cr/especial/redquepos.png", tableUrl: "https://www.imn.ac.cr/especial/tablas/quepos.html", coordinateNote: "Ubicación de referencia de Quepos; no representa necesariamente el sensor exacto." },
  { id: "imn-la-ligia", name: "Estación IMN · La Ligia (Parrita)", zone: "Pacífico Central", lat: 9.5200, lon: -84.3250, url: "https://www.imn.ac.cr/especial/estacionligia.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/laligia.html", coordinateNote: "Ubicación de referencia de Parrita/La Ligia; no representa necesariamente el sensor exacto." },
  { id: "imn-horquetas", name: "Estación IMN · Horquetas", zone: "Zona Norte", lat: 10.3270, lon: -83.9370, url: "https://www.imn.ac.cr/especial/tablas/horquetas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/horquetas.html", coordinateNote: "Ubicación de referencia de Horquetas, Sarapiquí; no representa necesariamente el sensor exacto." },
  { id: "imn-universidad-para-la-paz", name: "Estación IMN · Universidad para la Paz", zone: "Valle Central", lat: 9.9160, lon: -84.2420, url: "https://www.imn.ac.cr/especial/tablas/upaz.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/upaz.html", coordinateNote: "Ubicación de referencia de Universidad para la Paz, Mora; no representa necesariamente el sensor exacto." },
  { id: "imn-santa-clara", name: "Estación IMN · ITCR Santa Clara", zone: "Zona Norte", lat: 10.3650, lon: -84.5120, url: "https://www.imn.ac.cr/especial/tablas/staclara.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/staclara.html", coordinateNote: "Ubicación de referencia de Santa Clara de San Carlos; no representa necesariamente el sensor exacto." },
  { id: "imn-montana-sagrada", name: "Estación IMN · Montaña Sagrada", zone: "Zona Norte", lat: 10.3810, lon: -84.3450, url: "https://www.imn.ac.cr/especial/tablas/msagrada.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/msagrada.html", coordinateNote: "Ubicación de referencia de Aguas Zarcas; no representa necesariamente el sensor exacto." },
  { id: "imn-sitio-mata", name: "Estación IMN · Sitio Mata", zone: "Caribe Sur", lat: 9.9900, lon: -83.6390, url: "https://www.imn.ac.cr/especial/tablas/sitiomata.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sitiomata.html", coordinateNote: "Ubicación de referencia de Sitio Mata, Turrialba; no representa necesariamente el sensor exacto." },
  { id: "imn-la-pastora", name: "Estación IMN · Escuela La Pastora", zone: "Caribe Sur", lat: 9.9400, lon: -83.7800, url: "https://www.imn.ac.cr/especial/tablas/lapastora.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lapastora.html", coordinateNote: "Ubicación de referencia de La Pastora, Turrialba; no representa necesariamente el sensor exacto." },
  { id: "imn-fabio-baudrit", name: "Estación IMN · Fabio Baudrit (La Garita)", zone: "Valle Central", lat: 10.005, lon: -84.265, url: "https://www.imn.ac.cr/especial/estacionFABIO.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/fabio.html", coordinateNote: "Ubicación aproximada por localidad (La Garita de Alajuela); no es la posición exacta del sensor." },
  { id: "imn-laguna-fraijanes", name: "Estación IMN · Laguna Fraijanes", zone: "Valle Central", lat: 10.134, lon: -84.195, url: "https://www.imn.ac.cr/especial/estacionFraijanes.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/fraijanes.html", coordinateNote: "Ubicación aproximada por localidad (Fraijanes, Alajuela); no es la posición exacta del sensor." },
  { id: "imn-recope-la-garita", name: "Estación IMN · RECOPE La Garita", zone: "Valle Central", lat: 9.995, lon: -84.285, url: "https://www.imn.ac.cr/especial/estacionGarita.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lagarita.html", coordinateNote: "Ubicación aproximada por localidad (La Garita, Alajuela); no es la posición exacta del sensor." },
  { id: "imn-cigefi", name: "Estación IMN · CIGEFI (San Pedro)", zone: "Valle Central", lat: 9.937, lon: -84.052, url: "https://www.imn.ac.cr/especial/estacionCigefi.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/cigefi.html", coordinateNote: "Ubicación aproximada por localidad (San Pedro de Montes de Oca); no es la posición exacta del sensor." },
  { id: "imn-jaboncillal", name: "Estación IMN · Jaboncillal (Goicoechea)", zone: "Valle Central", lat: 9.989, lon: -84.028, url: "https://www.imn.ac.cr/especial/estacionJaboncillal.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/jaboncillal.html", coordinateNote: "Ubicación aproximada por localidad (Goicoechea, San José); no es la posición exacta del sensor." },
  { id: "imn-finca-los-macaya", name: "Estación IMN · Finca Los Macaya (Goicoechea)", zone: "Valle Central", lat: 9.98, lon: -84.015, url: "https://www.imn.ac.cr/especial/estacionMacaya.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/macaya.html", coordinateNote: "Ubicación aproximada por localidad (Goicoechea, San José); no es la posición exacta del sensor." },
  { id: "imn-belen", name: "Estación IMN · Belén", zone: "Valle Central", lat: 9.977, lon: -84.186, url: "https://www.imn.ac.cr/especial/estacionBelen.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/belen.html", coordinateNote: "Ubicación aproximada por localidad (Belén, Heredia); no es la posición exacta del sensor." },
  { id: "imn-ciudad-judicial", name: "Estación IMN · Ciudad Judicial (San Joaquín)", zone: "Valle Central", lat: 9.996, lon: -84.155, url: "https://www.imn.ac.cr/especial/estacionJudicial.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/ciudadjudicial.html", coordinateNote: "Ubicación aproximada por localidad (San Joaquín de Flores, Heredia); no es la posición exacta del sensor." },
  { id: "imn-santa-barbara", name: "Estación IMN · Santa Bárbara de Heredia", zone: "Valle Central", lat: 10.039, lon: -84.15, url: "https://www.imn.ac.cr/especial/estacionSTB.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/stabarbara.html", coordinateNote: "Ubicación aproximada por localidad (Santa Bárbara, Heredia); no es la posición exacta del sensor." },
  { id: "imn-santa-lucia", name: "Estación IMN · Santa Lucía de Barva", zone: "Valle Central", lat: 10.028, lon: -84.125, url: "https://www.imn.ac.cr/especial/estacionsantalucia.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/stalucia.html", coordinateNote: "Ubicación aproximada por localidad (Santa Lucía, Barva, Heredia); no es la posición exacta del sensor." },
  { id: "imn-volcan-poas", name: "Estación IMN · Laguna del Volcán Poás", zone: "Valle Central", lat: 10.198, lon: -84.231, url: "https://www.imn.ac.cr/especial/estacionPoas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/vpoas.html", coordinateNote: "Ubicación aproximada por localidad (laguna del volcán Poás (cumbre, ~2.700 m)); no es la posición exacta del sensor." },
  { id: "imn-aeropuerto-sjo-07", name: "Estación IMN · Aeropuerto Juan Santamaría 07", zone: "Valle Central", lat: 9.9939, lon: -84.2088, url: "https://www.imn.ac.cr/especial/tablas/aijs07.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/aijs07.html", coordinateNote: "Coordenada de referencia del aeropuerto; no representa necesariamente el sensor exacto." },
  { id: "imn-aeropuerto-liberia-07", name: "Estación IMN · Aeropuerto Daniel Oduber 07", zone: "Pacífico Norte", lat: 10.5933, lon: -85.5444, url: "https://www.imn.ac.cr/especial/tablas/lib07.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lib07.html", coordinateNote: "Coordenada de referencia del aeropuerto; no representa necesariamente el sensor exacto." },
  { id: "imn-sixaola", name: "Estación IMN · Sixaola", zone: "Caribe Sur", lat: 9.5300, lon: -82.6200, url: "https://www.imn.ac.cr/especial/tablas/sixaola.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sixaola.html", coordinateNote: "Ubicación de referencia de Sixaola, Talamanca; no representa necesariamente el sensor exacto." },
  { id: "imn-guayabob", name: "Estación IMN · ASADA Guayabo (Bagaces)", zone: "Pacífico Norte", lat: 10.7079, lon: -85.2255, url: "https://www.imn.ac.cr/especial/estacionGuayabo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/guayabob.html", coordinateNote: "Ubicación aproximada por localidad (ASADA Guayabo (Bagaces)); no es la posición exacta del sensor." },
  { id: "imn-aranjuez-pitahaya", name: "Estación IMN · Aranjuez, Pitahaya (Puntarenas)", zone: "Pacífico Norte", lat: 9.9889, lon: -84.8259, url: "https://www.imn.ac.cr/especial/estacionAranjuez.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/aranjuez.html", coordinateNote: "Ubicación aproximada por cantón (Aranjuez, Pitahaya (Puntarenas)); el sensor puede estar a varios kilómetros." },
  { id: "imn-sardinal", name: "Estación IMN · ASADA Artola (Sardinal, Carrillo)", zone: "Pacífico Norte", lat: 10.5106, lon: -85.6814, url: "https://www.imn.ac.cr/especial/estacionSardinal.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sardinal.html", coordinateNote: "Ubicación aproximada por localidad (ASADA Artola (Sardinal, Carrillo)); no es la posición exacta del sensor." },
  { id: "imn-pilangosta", name: "Estación IMN · ASADA Pilangosta (Hojancha)", zone: "Pacífico Norte", lat: 10.0276, lon: -85.4016, url: "https://www.imn.ac.cr/especial/estacionPilangosta.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pilangosta.html", coordinateNote: "Ubicación aproximada por localidad (ASADA Pilangosta (Hojancha)); no es la posición exacta del sensor." },
  { id: "imn-stamarta", name: "Estación IMN · ASADA Santa Marta (Hojancha)", zone: "Pacífico Norte", lat: 10.045, lon: -85.37, url: "https://www.imn.ac.cr/especial/estacionStaMarta.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/stamarta.html", coordinateNote: "Ubicación aproximada por cantón (ASADA Santa Marta (Hojancha)); el sensor puede estar a varios kilómetros." },
  { id: "imn-garza", name: "Estación IMN · Barco Quebrado, Garza (Nosara)", zone: "Pacífico Norte", lat: 9.9022, lon: -85.5893, url: "https://www.imn.ac.cr/especial/estacionGarza.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/garza.html", coordinateNote: "Ubicación aproximada por localidad (Barco Quebrado, Garza (Nosara)); no es la posición exacta del sensor." },
  { id: "imn-huacalito", name: "Estación IMN · Cerro Huacalito (Carrillo)", zone: "Pacífico Norte", lat: 10.4333, lon: -85.6167, url: "https://www.imn.ac.cr/especial/estacionHuacalito.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/huacalito.html", coordinateNote: "Ubicación aproximada por cantón (Cerro Huacalito (Carrillo)); el sensor puede estar a varios kilómetros." },
  { id: "imn-copalchi", name: "Estación IMN · Copalchí (Peñas Blancas)", zone: "Pacífico Norte", lat: 10.116, lon: -84.669, url: "https://www.imn.ac.cr/especial/estacionCopalchi.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/copalchi.html", coordinateNote: "Ubicación aproximada por cantón (Copalchí (Peñas Blancas)); el sensor puede estar a varios kilómetros." },
  { id: "imn-bijagua", name: "Estación IMN · Coopeguanacaste, Bijagua (Upala)", zone: "Pacífico Norte", lat: 10.7167, lon: -85.0333, url: "https://www.imn.ac.cr/especial/estacionBijagua.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/bijagua.html", coordinateNote: "Ubicación aproximada por localidad (Coopeguanacaste, Bijagua (Upala)); no es la posición exacta del sensor." },
  { id: "imn-puravida", name: "Estación IMN · Dulce Nombre (Nicoya)", zone: "Pacífico Norte", lat: 10.15, lon: -85.45, url: "https://www.imn.ac.cr/especial/estacionPuraVida.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/puravida.html", coordinateNote: "Ubicación aproximada por cantón (Dulce Nombre (Nicoya)); el sensor puede estar a varios kilómetros." },
  { id: "imn-paloverde", name: "Estación IMN · El Corral, Palo Verde", zone: "Pacífico Norte", lat: 10.35, lon: -85.34, url: "https://www.imn.ac.cr/especial/estacionpaloverde.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/paloverde.html", coordinateNote: "Ubicación aproximada por localidad (El Corral, Palo Verde); no es la posición exacta del sensor." },
  { id: "imn-laceiba", name: "Estación IMN · Finca La Ceiba (Nicoya)", zone: "Pacífico Norte", lat: 10.16, lon: -85.47, url: "https://www.imn.ac.cr/especial/estacionLaCeiba.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/laceiba.html", coordinateNote: "Ubicación aproximada por cantón (Finca La Ceiba (Nicoya)); el sensor puede estar a varios kilómetros." },
  { id: "imn-mojica", name: "Estación IMN · Hacienda Mojica (Bagaces)", zone: "Pacífico Norte", lat: 10.4054, lon: -85.196, url: "https://www.imn.ac.cr/especial/estacionMojica.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/mojica.html", coordinateNote: "Ubicación aproximada por localidad (Hacienda Mojica (Bagaces)); no es la posición exacta del sensor." },
  { id: "imn-taboga", name: "Estación IMN · Hacienda Taboga (Cañas)", zone: "Pacífico Norte", lat: 10.3504, lon: -85.178, url: "https://www.imn.ac.cr/especial/estacionTaboga.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/taboga.html", coordinateNote: "Ubicación aproximada por localidad (Hacienda Taboga (Cañas)); no es la posición exacta del sensor." },
  { id: "imn-lacruz", name: "Estación IMN · La Cruz (Guanacaste)", zone: "Pacífico Norte", lat: 11.0738, lon: -85.6327, url: "https://www.imn.ac.cr/especial/estacionLaCruz.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lacruz.html", coordinateNote: "Ubicación aproximada por localidad (La Cruz (Guanacaste)); no es la posición exacta del sensor." },
  { id: "imn-mangarica", name: "Estación IMN · Mangarica (Liberia)", zone: "Pacífico Norte", lat: 10.6352, lon: -85.4378, url: "https://www.imn.ac.cr/especial/estacionMangarica.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/mangarica.html", coordinateNote: "Ubicación aproximada por cantón (Mangarica (Liberia)); el sensor puede estar a varios kilómetros." },
  { id: "imn-maritza", name: "Estación IMN · Maritza, Volcán Orosi", zone: "Pacífico Norte", lat: 10.97, lon: -85.5, url: "https://www.imn.ac.cr/especial/estacionMaritza.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/maritza.html", coordinateNote: "Ubicación aproximada por localidad (Maritza, Volcán Orosi); no es la posición exacta del sensor." },
  { id: "imn-guinea", name: "Estación IMN · Miel, La Guinea (Carrillo)", zone: "Pacífico Norte", lat: 10.4, lon: -85.55, url: "https://www.imn.ac.cr/especial/estacionlaGuinea.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/guinea.html", coordinateNote: "Ubicación aproximada por cantón (Miel, La Guinea (Carrillo)); el sensor puede estar a varios kilómetros." },
  { id: "imn-oroceiba", name: "Estación IMN · Oroceiba (Orotina)", zone: "Pacífico Norte", lat: 9.9119, lon: -84.5234, url: "https://www.imn.ac.cr/especial/estacionOroceiba.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/oroceiba.html", coordinateNote: "Ubicación aproximada por cantón (Oroceiba (Orotina)); el sensor puede estar a varios kilómetros." },
  { id: "imn-nicoya", name: "Estación IMN · Nicoya", zone: "Pacífico Norte", lat: 10.1504, lon: -85.4509, url: "https://www.imn.ac.cr/especial/estacionNicoya.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/nicoya.html", coordinateNote: "Ubicación aproximada por localidad (Nicoya); no es la posición exacta del sensor." },
  { id: "imn-montezuma", name: "Estación IMN · Palo Alto, Montezuma (Cañas)", zone: "Pacífico Norte", lat: 10.4, lon: -85.12, url: "https://www.imn.ac.cr/especial/estacionMontezuma.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/montezuma.html", coordinateNote: "Ubicación aproximada por cantón (Palo Alto, Montezuma (Cañas)); el sensor puede estar a varios kilómetros." },
  { id: "imn-paquera", name: "Estación IMN · Paquera", zone: "Pacífico Norte", lat: 9.8201, lon: -84.9351, url: "https://www.imn.ac.cr/especial/estacionPaquera.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/paquera.html", coordinateNote: "Ubicación aproximada por localidad (Paquera); no es la posición exacta del sensor." },
  { id: "imn-negritos", name: "Estación IMN · Puesto Negritos, P.N. Palo Verde", zone: "Pacífico Norte", lat: 10.33, lon: -85.37, url: "https://www.imn.ac.cr/especial/estacionNegritos.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/negritos.html", coordinateNote: "Ubicación aproximada por localidad (Puesto Negritos, P.N. Palo Verde); no es la posición exacta del sensor." },
  { id: "imn-puntarenas", name: "Estación IMN · Puntarenas", zone: "Pacífico Norte", lat: 9.9769, lon: -84.8379, url: "https://www.imn.ac.cr/especial/estacionPuntarenas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/puntarenas.html", coordinateNote: "Ubicación aproximada por localidad (Puntarenas); no es la posición exacta del sensor." },
  { id: "imn-cipanci", name: "Estación IMN · Refugio Cipanci (Cañas)", zone: "Pacífico Norte", lat: 10.4311, lon: -85.0982, url: "https://www.imn.ac.cr/especial/estacionCipanci.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/cipanci.html", coordinateNote: "Ubicación aproximada por cantón (Refugio Cipanci (Cañas)); el sensor puede estar a varios kilómetros." },
  { id: "imn-pinilla", name: "Estación IMN · San José, Pinilla (Santa Cruz)", zone: "Pacífico Norte", lat: 10.27, lon: -85.74, url: "https://www.imn.ac.cr/especial/estacionPinilla.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pinilla.html", coordinateNote: "Ubicación aproximada por localidad (San José, Pinilla (Santa Cruz)); no es la posición exacta del sensor." },
  { id: "imn-sanmateo", name: "Estación IMN · San Mateo", zone: "Pacífico Norte", lat: 9.9363, lon: -84.522, url: "https://www.imn.ac.cr/especial/estacionSanMateo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sanmateo.html", coordinateNote: "Ubicación aproximada por localidad (San Mateo); no es la posición exacta del sensor." },
  { id: "imn-stacecilia", name: "Estación IMN · Santa Cecilia (La Cruz)", zone: "Pacífico Norte", lat: 11.0629, lon: -85.4139, url: "https://www.imn.ac.cr/especial/estacionStacecilia.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/stacecilia.html", coordinateNote: "Ubicación aproximada por localidad (Santa Cecilia (La Cruz)); no es la posición exacta del sensor." },
  { id: "imn-staelena", name: "Estación IMN · Santa Elena (La Cruz)", zone: "Pacífico Norte", lat: 11.0, lon: -85.58, url: "https://www.imn.ac.cr/especial/estacionStaElena.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/staelena.html", coordinateNote: "Ubicación aproximada por cantón (Santa Elena (La Cruz)); el sensor puede estar a varios kilómetros." },
  { id: "imn-nandayure", name: "Estación IMN · Santa Rita (Nandayure)", zone: "Pacífico Norte", lat: 10.0, lon: -85.25, url: "https://www.imn.ac.cr/especial/estacionNandayure.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/nandayure.html", coordinateNote: "Ubicación aproximada por cantón (Santa Rita (Nandayure)); el sensor puede estar a varios kilómetros." },
  { id: "imn-santarosa", name: "Estación IMN · Santa Rosa (P.N. Santa Rosa)", zone: "Pacífico Norte", lat: 10.84, lon: -85.619, url: "https://www.imn.ac.cr/especial/estacionstarosa.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/santarosa.html", coordinateNote: "Ubicación aproximada por localidad (Santa Rosa (P.N. Santa Rosa)); no es la posición exacta del sensor." },
  { id: "imn-sitiolacruz", name: "Estación IMN · Sitio La Cruz (Bagaces)", zone: "Pacífico Norte", lat: 10.5254, lon: -85.2554, url: "https://www.imn.ac.cr/especial/estacionSitioLaCruz.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sitiolacruz.html", coordinateNote: "Ubicación aproximada por cantón (Sitio La Cruz (Bagaces)); el sensor puede estar a varios kilómetros." },
  { id: "imn-invenio", name: "Estación IMN · Universidad INVENIO (Cañas)", zone: "Pacífico Norte", lat: 10.4, lon: -85.09, url: "https://www.imn.ac.cr/especial/estacionInvenio.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/invenio.html", coordinateNote: "Ubicación aproximada por cantón (Universidad INVENIO (Cañas)); el sensor puede estar a varios kilómetros." },
  { id: "imn-stacruz", name: "Estación IMN · UCR Santa Cruz", zone: "Pacífico Norte", lat: 10.2605, lon: -85.5851, url: "https://www.imn.ac.cr/especial/estacionStacruz.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/stacruz.html", coordinateNote: "Ubicación aproximada por localidad (UCR Santa Cruz); no es la posición exacta del sensor." },
  { id: "imn-arunachala", name: "Estación IMN · Arunachala (Pérez Zeledón)", zone: "Pacífico Central", lat: 9.37, lon: -83.7, url: "https://www.imn.ac.cr/especial/estacionArunachala.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/arunachala.html", coordinateNote: "Ubicación aproximada por cantón (Arunachala (Pérez Zeledón)); el sensor puede estar a varios kilómetros." },
  { id: "imn-sgabriel", name: "Estación IMN · ASADA San Gabriel (Desamparados)", zone: "Pacífico Central", lat: 9.87, lon: -84.08, url: "https://www.imn.ac.cr/especial/estacionSangabriel.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sgabriel.html", coordinateNote: "Ubicación aproximada por localidad (ASADA San Gabriel (Desamparados)); no es la posición exacta del sensor." },
  { id: "imn-tarrazu", name: "Estación IMN · El Rodeo (Tarrazú)", zone: "Pacífico Central", lat: 9.66, lon: -84.03, url: "https://www.imn.ac.cr/especial/estacionTarrazu.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/tarrazu.html", coordinateNote: "Ubicación aproximada por cantón (El Rodeo (Tarrazú)); el sensor puede estar a varios kilómetros." },
  { id: "imn-damas", name: "Estación IMN · Finca Damas (Quepos)", zone: "Pacífico Central", lat: 9.4924, lon: -84.2117, url: "https://www.imn.ac.cr/especial/estacionDamas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/damas.html", coordinateNote: "Ubicación aproximada por localidad (Finca Damas (Quepos)); no es la posición exacta del sensor." },
  { id: "imn-lalucha", name: "Estación IMN · La Lucha (León Cortés)", zone: "Pacífico Central", lat: 9.69, lon: -84.04, url: "https://www.imn.ac.cr/especial/estacionLucha.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lalucha.html", coordinateNote: "Ubicación aproximada por cantón (La Lucha (León Cortés)); el sensor puede estar a varios kilómetros." },
  { id: "imn-herradura", name: "Estación IMN · Muelle Herradura (Garabito)", zone: "Pacífico Central", lat: 9.66, lon: -84.64, url: "https://www.imn.ac.cr/especial/estacionHerradura.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/herradura.html", coordinateNote: "Ubicación aproximada por localidad (Muelle Herradura (Garabito)); no es la posición exacta del sensor." },
  { id: "imn-altamira", name: "Estación IMN · Altamira (Buenos Aires)", zone: "Pacífico Sur", lat: 9.173, lon: -83.3328, url: "https://www.imn.ac.cr/especial/estacionAltamira.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/altamira.html", coordinateNote: "Ubicación aproximada por cantón (Altamira (Buenos Aires)); el sensor puede estar a varios kilómetros." },
  { id: "imn-giro", name: "Estación IMN · Cafetalera El Giro (San Vito)", zone: "Pacífico Sur", lat: 8.83, lon: -82.99, url: "https://www.imn.ac.cr/especial/estacionGiro.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/giro.html", coordinateNote: "Ubicación aproximada por cantón (Cafetalera El Giro (San Vito)); el sensor puede estar a varios kilómetros." },
  { id: "imn-sanvito", name: "Estación IMN · Cafetalera El Indio (San Vito)", zone: "Pacífico Sur", lat: 8.8208, lon: -82.9709, url: "https://www.imn.ac.cr/especial/estacionSanVito.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sanvito.html", coordinateNote: "Ubicación aproximada por localidad (Cafetalera El Indio (San Vito)); no es la posición exacta del sensor." },
  { id: "imn-chirripo", name: "Estación IMN · Cerro Chirripó", zone: "Pacífico Sur", lat: 9.4844, lon: -83.489, url: "https://www.imn.ac.cr/especial/estacionChirripo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/chirripo.html", coordinateNote: "Ubicación aproximada por localidad (Cerro Chirripó); no es la posición exacta del sensor." },
  { id: "imn-coto49", name: "Estación IMN · Coto 49 (Corredores)", zone: "Pacífico Sur", lat: 8.61, lon: -82.96, url: "https://www.imn.ac.cr/especial/estacionCoto49.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/coto49.html", coordinateNote: "Ubicación aproximada por localidad (Coto 49 (Corredores)); no es la posición exacta del sensor." },
  { id: "imn-jimenez", name: "Estación IMN · Finca El Patio, Puerto Jiménez", zone: "Pacífico Sur", lat: 8.5333, lon: -83.3, url: "https://www.imn.ac.cr/especial/estacionJimenez.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/jimenez.html", coordinateNote: "Ubicación aproximada por localidad (Finca El Patio, Puerto Jiménez); no es la posición exacta del sensor." },
  { id: "imn-neotropica", name: "Estación IMN · Fundación Neotrópica (Osa)", zone: "Pacífico Sur", lat: 8.9667, lon: -83.4833, url: "https://www.imn.ac.cr/especial/estacionNeotropica.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/neotropica.html", coordinateNote: "Ubicación aproximada por cantón (Fundación Neotrópica (Osa)); el sensor puede estar a varios kilómetros." },
  { id: "imn-lasbrisas", name: "Estación IMN · Las Brisas, Sabalito (Coto Brus)", zone: "Pacífico Sur", lat: 8.9, lon: -82.82, url: "https://www.imn.ac.cr/especial/estacionLasBrisas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lasbrisas.html", coordinateNote: "Ubicación aproximada por localidad (Las Brisas, Sabalito (Coto Brus)); no es la posición exacta del sensor." },
  { id: "imn-laurel", name: "Estación IMN · Laurel (Corredores)", zone: "Pacífico Sur", lat: 8.43, lon: -82.94, url: "https://www.imn.ac.cr/especial/estacionLaurel.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/laurel.html", coordinateNote: "Ubicación aproximada por cantón (Laurel (Corredores)); el sensor puede estar a varios kilómetros." },
  { id: "imn-montecarlo", name: "Estación IMN · Montecarlo (Pérez Zeledón)", zone: "Pacífico Sur", lat: 9.4, lon: -83.65, url: "https://www.imn.ac.cr/especial/estacionMontecarlo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/montecarlo.html", coordinateNote: "Ubicación aproximada por cantón (Montecarlo (Pérez Zeledón)); el sensor puede estar a varios kilómetros." },
  { id: "imn-museo", name: "Estación IMN · Museo Finca 6 (Osa)", zone: "Pacífico Sur", lat: 8.9514, lon: -83.4747, url: "https://www.imn.ac.cr/especial/estacionMuseo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/museo.html", coordinateNote: "Ubicación aproximada por localidad (Museo Finca 6 (Osa)); no es la posición exacta del sensor." },
  { id: "imn-pindeco", name: "Estación IMN · PINDECO (Buenos Aires)", zone: "Pacífico Sur", lat: 9.17, lon: -83.33, url: "https://www.imn.ac.cr/especial/estacionPindeco.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pindeco.html", coordinateNote: "Ubicación aproximada por localidad (PINDECO (Buenos Aires)); no es la posición exacta del sensor." },
  { id: "imn-greggund", name: "Estación IMN · Reserva Biológica Greg Gund (Golfito)", zone: "Pacífico Sur", lat: 8.7, lon: -83.2, url: "https://www.imn.ac.cr/especial/estacionGreggund.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/greggund.html", coordinateNote: "Ubicación aproximada por cantón (Reserva Biológica Greg Gund (Golfito)); el sensor puede estar a varios kilómetros." },
  { id: "imn-rioclaro", name: "Estación IMN · Río Claro (Golfito)", zone: "Pacífico Sur", lat: 8.69, lon: -83.07, url: "https://www.imn.ac.cr/especial/estacionRioclaro.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/rioclaro.html", coordinateNote: "Ubicación aproximada por localidad (Río Claro (Golfito)); no es la posición exacta del sensor." },
  { id: "imn-aeropzn", name: "Estación IMN · Aeródromo Zona Norte (San Carlos)", zone: "Zona Norte", lat: 10.3231, lon: -84.4272, url: "https://www.imn.ac.cr/especial/estacionAeropzn.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/aeropzn.html", coordinateNote: "Ubicación aproximada por cantón (Aeródromo Zona Norte (San Carlos)); el sensor puede estar a varios kilómetros." },
  { id: "imn-fortuna", name: "Estación IMN · ADIFORT, La Fortuna (San Carlos)", zone: "Zona Norte", lat: 10.4679, lon: -84.6427, url: "https://www.imn.ac.cr/especial/estacionfortuna.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/fortuna.html", coordinateNote: "Ubicación aproximada por localidad (ADIFORT, La Fortuna (San Carlos)); no es la posición exacta del sensor." },
  { id: "imn-guatuso", name: "Estación IMN · ASADA San Rafael de Guatuso", zone: "Zona Norte", lat: 10.6667, lon: -84.8167, url: "https://www.imn.ac.cr/especial/estacionGuatuso.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/guatuso.html", coordinateNote: "Ubicación aproximada por localidad (ASADA San Rafael de Guatuso); no es la posición exacta del sensor." },
  { id: "imn-balsa", name: "Estación IMN · Balsa (San Ramón)", zone: "Zona Norte", lat: 10.1728, lon: -84.5017, url: "https://www.imn.ac.cr/especial/estacionBalsa.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/balsa.html", coordinateNote: "Ubicación aproximada por localidad (Balsa (San Ramón)); no es la posición exacta del sensor." },
  { id: "imn-betania", name: "Estación IMN · Betania, Cutris (San Carlos)", zone: "Zona Norte", lat: 10.48, lon: -84.33, url: "https://www.imn.ac.cr/especial/estacionBetania.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/betania.html", coordinateNote: "Ubicación aproximada por cantón (Betania, Cutris (San Carlos)); el sensor puede estar a varios kilómetros." },
  { id: "imn-pvsarapiqui", name: "Estación IMN · Comando Puerto Viejo (Sarapiquí)", zone: "Zona Norte", lat: 10.456, lon: -84.007, url: "https://www.imn.ac.cr/especial/estacionSarapiqui.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pvsarapiqui.html", coordinateNote: "Ubicación aproximada por localidad (Comando Puerto Viejo (Sarapiquí)); no es la posición exacta del sensor." },
  { id: "imn-hidroelectrica", name: "Estación IMN · Hidroeléctrica El General (Sarapiquí)", zone: "Zona Norte", lat: 10.4833, lon: -84.0167, url: "https://www.imn.ac.cr/especial/estacionHidroelectrica.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/hidroelectrica.html", coordinateNote: "Ubicación aproximada por cantón (Hidroeléctrica El General (Sarapiquí)); el sensor puede estar a varios kilómetros." },
  { id: "imn-tirimbina", name: "Estación IMN · El Bosque, Río Tirimbina (Sarapiquí)", zone: "Zona Norte", lat: 10.416, lon: -84.12, url: "https://www.imn.ac.cr/especial/estacionTirimbina.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/tirimbina.html", coordinateNote: "Ubicación aproximada por localidad (El Bosque, Río Tirimbina (Sarapiquí)); no es la posición exacta del sensor." },
  { id: "imn-brasilia", name: "Estación IMN · Finca Brasilia (Upala)", zone: "Zona Norte", lat: 10.85, lon: -85.0, url: "https://www.imn.ac.cr/especial/estacionBrasilia.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/brasilia.html", coordinateNote: "Ubicación aproximada por cantón (Finca Brasilia (Upala)); el sensor puede estar a varios kilómetros." },
  { id: "imn-pozoazul", name: "Estación IMN · Hotel Pozo Azul (Sarapiquí)", zone: "Zona Norte", lat: 10.37, lon: -84.17, url: "https://www.imn.ac.cr/especial/estacionPozoazul.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pozoazul.html", coordinateNote: "Ubicación aproximada por cantón (Hotel Pozo Azul (Sarapiquí)); el sensor puede estar a varios kilómetros." },
  { id: "imn-vblanca", name: "Estación IMN · Hotel Villa Blanca (San Ramón)", zone: "Zona Norte", lat: 10.215, lon: -84.517, url: "https://www.imn.ac.cr/especial/estacionVblanca.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/vblanca.html", coordinateNote: "Ubicación aproximada por localidad (Hotel Villa Blanca (San Ramón)); no es la posición exacta del sensor." },
  { id: "imn-larebusca", name: "Estación IMN · La Rebusca (Sarapiquí)", zone: "Zona Norte", lat: 10.4953, lon: -84.0027, url: "https://www.imn.ac.cr/especial/estacionRebusca.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/larebusca.html", coordinateNote: "Ubicación aproximada por cantón (La Rebusca (Sarapiquí)); el sensor puede estar a varios kilómetros." },
  { id: "imn-lasdelicias", name: "Estación IMN · Las Delicias (San Carlos)", zone: "Zona Norte", lat: 10.3, lon: -84.45, url: "https://www.imn.ac.cr/especial/estacionDelicias.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/lasdelicias.html", coordinateNote: "Ubicación aproximada por cantón (Las Delicias (San Carlos)); el sensor puede estar a varios kilómetros." },
  { id: "imn-loschiles", name: "Estación IMN · Los Chiles", zone: "Zona Norte", lat: 11.0325, lon: -84.7154, url: "https://www.imn.ac.cr/especial/estacionChiles.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/loschiles.html", coordinateNote: "Ubicación aproximada por localidad (Los Chiles); no es la posición exacta del sensor." },
  { id: "imn-sanvicente", name: "Estación IMN · San Vicente, Ciudad Quesada", zone: "Zona Norte", lat: 10.33, lon: -84.42, url: "https://www.imn.ac.cr/especial/estacionSanVicente.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sanvicente.html", coordinateNote: "Ubicación aproximada por localidad (San Vicente, Ciudad Quesada); no es la posición exacta del sensor." },
  { id: "imn-sangerardo", name: "Estación IMN · San Gerardo (Sarapiquí)", zone: "Zona Norte", lat: 10.4163, lon: -84.1613, url: "https://www.imn.ac.cr/especial/estacionSanGerardo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/sangerardo.html", coordinateNote: "Ubicación aproximada por localidad (San Gerardo (Sarapiquí)); no es la posición exacta del sensor." },
  { id: "imn-upala", name: "Estación IMN · Upala", zone: "Zona Norte", lat: 10.8991, lon: -85.0137, url: "https://www.imn.ac.cr/especial/estacionupala.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/upala.html", coordinateNote: "Ubicación aproximada por localidad (Upala); no es la posición exacta del sensor." },
  { id: "imn-tenorio", name: "Estación IMN · Volcán Tenorio", zone: "Zona Norte", lat: 10.67, lon: -85.02, url: "https://www.imn.ac.cr/especial/estacionTenorio.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/tenorio.html", coordinateNote: "Ubicación aproximada por localidad (Volcán Tenorio); no es la posición exacta del sensor." },
  { id: "imn-aitbp09", name: "Estación IMN · Aeropuerto Tobías Bolaños (Pavas)", zone: "Valle Central", lat: 9.9571, lon: -84.1398, url: "https://www.imn.ac.cr/especial/estacionAitbp09.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/aitbp09.html", coordinateNote: "Ubicación aproximada por localidad (Aeropuerto Tobías Bolaños (Pavas)); no es la posición exacta del sensor." },
  { id: "imn-alfredovolio", name: "Estación IMN · Alfredo Volio Mata (Cartago)", zone: "Valle Central", lat: 9.8637, lon: -83.9195, url: "https://www.imn.ac.cr/especial/estacionAlfredoVolio.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/alfredovolio.html", coordinateNote: "Ubicación aproximada por localidad (Alfredo Volio Mata (Cartago)); no es la posición exacta del sensor." },
  { id: "imn-barrancas", name: "Estación IMN · Barrancas (El Guarco)", zone: "Valle Central", lat: 9.8332, lon: -83.9668, url: "https://www.imn.ac.cr/especial/estacionBarrancas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/barrancas.html", coordinateNote: "Ubicación aproximada por localidad (Barrancas (El Guarco)); no es la posición exacta del sensor." },
  { id: "imn-burio", name: "Estación IMN · Cerro Burío (Aserrí)", zone: "Valle Central", lat: 9.8614, lon: -84.0927, url: "https://www.imn.ac.cr/especial/estacionBurio.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/burio.html", coordinateNote: "Ubicación aproximada por localidad (Cerro Burío (Aserrí)); no es la posición exacta del sensor." },
  { id: "imn-chitaria", name: "Estación IMN · Cerro Chitaria (Santa Ana)", zone: "Valle Central", lat: 9.9326, lon: -84.1826, url: "https://www.imn.ac.cr/especial/estacionchitaria.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/chitaria.html", coordinateNote: "Ubicación aproximada por localidad (Cerro Chitaria (Santa Ana)); no es la posición exacta del sensor." },
  { id: "imn-juco", name: "Estación IMN · Cerro Jucó (Paraíso)", zone: "Valle Central", lat: 9.8386, lon: -83.8665, url: "https://www.imn.ac.cr/especial/estacionJuco.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/juco.html", coordinateNote: "Ubicación aproximada por cantón (Cerro Jucó (Paraíso)); el sensor puede estar a varios kilómetros." },
  { id: "imn-ciudadninos", name: "Estación IMN · Ciudad de los Niños (Cartago)", zone: "Valle Central", lat: 9.88, lon: -83.93, url: "https://www.imn.ac.cr/especial/estacionCiudadninos.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/ciudadninos.html", coordinateNote: "Ubicación aproximada por cantón (Ciudad de los Niños (Cartago)); el sensor puede estar a varios kilómetros." },
  { id: "imn-munistaana1", name: "Estación IMN · CRRV, Plantel Municipal (Santa Ana)", zone: "Valle Central", lat: 9.9436, lon: -84.1706, url: "https://www.imn.ac.cr/especial/estacionMuniStaAna.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/munistaana1.html", coordinateNote: "Ubicación aproximada por cantón (CRRV, Plantel Municipal (Santa Ana)); el sensor puede estar a varios kilómetros." },
  { id: "imn-munistaana2", name: "Estación IMN · Residencial Bosques (Santa Ana)", zone: "Valle Central", lat: 9.938, lon: -84.175, url: "https://www.imn.ac.cr/especial/estacionMuniStaAnaBosques.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/munistaana2.html", coordinateNote: "Ubicación aproximada por cantón (Residencial Bosques (Santa Ana)); el sensor puede estar a varios kilómetros." },
  { id: "imn-munistaana4", name: "Estación IMN · Residencial Paraíso, Piedades (Santa Ana)", zone: "Valle Central", lat: 9.915, lon: -84.2, url: "https://www.imn.ac.cr/especial/estacionMuniStaAnaParaiso.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/munistaana4.html", coordinateNote: "Ubicación aproximada por localidad (Residencial Paraíso, Piedades (Santa Ana)); no es la posición exacta del sensor." },
  { id: "imn-dnombre", name: "Estación IMN · Dulce Nombre (Cartago)", zone: "Valle Central", lat: 9.878, lon: -83.965, url: "https://www.imn.ac.cr/especial/estacionLindaVistadn.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/dnombre.html", coordinateNote: "Ubicación aproximada por localidad (Dulce Nombre (Cartago)); no es la posición exacta del sensor." },
  { id: "imn-loslotes", name: "Estación IMN · Finca Los Lotes (La Unión)", zone: "Valle Central", lat: 9.9, lon: -83.983, url: "https://www.imn.ac.cr/especial/estacionLoslotes.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/loslotes.html", coordinateNote: "Ubicación aproximada por cantón (Finca Los Lotes (La Unión)); el sensor puede estar a varios kilómetros." },
  { id: "imn-iztaru", name: "Estación IMN · Iztarú (La Unión)", zone: "Valle Central", lat: 9.95, lon: -83.94, url: "https://www.imn.ac.cr/especial/estacionIztaru.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/iztaru.html", coordinateNote: "Ubicación aproximada por cantón (Iztarú (La Unión)); el sensor puede estar a varios kilómetros." },
  { id: "imn-llanogrande", name: "Estación IMN · Llano Grande (Cartago)", zone: "Valle Central", lat: 9.9393, lon: -83.9088, url: "https://www.imn.ac.cr/especial/estacionLlanogrande.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/llanogrande.html", coordinateNote: "Ubicación aproximada por localidad (Llano Grande (Cartago)); no es la posición exacta del sensor." },
  { id: "imn-patio", name: "Estación IMN · Patio de Agua (Coronado)", zone: "Valle Central", lat: 9.9788, lon: -83.995, url: "https://www.imn.ac.cr/especial/estacionPatio.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/patio.html", coordinateNote: "Ubicación aproximada por cantón (Patio de Agua (Coronado)); el sensor puede estar a varios kilómetros." },
  { id: "imn-pacayas", name: "Estación IMN · Pacayas (Alvarado)", zone: "Valle Central", lat: 9.942, lon: -83.818, url: "https://www.imn.ac.cr/especial/estacionPacayas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/pacayas.html", coordinateNote: "Ubicación aproximada por localidad (Pacayas (Alvarado)); no es la posición exacta del sensor." },
  { id: "imn-ochomogo", name: "Estación IMN · RECOPE Ochomogo (Cartago)", zone: "Valle Central", lat: 9.8887, lon: -83.9387, url: "https://www.imn.ac.cr/especial/estacionOchomogo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/ochomogo.html", coordinateNote: "Ubicación aproximada por localidad (RECOPE Ochomogo (Cartago)); no es la posición exacta del sensor." },
  { id: "imn-potrerocerrado", name: "Estación IMN · Sartalillo, Potrero Cerrado (Oreamuno)", zone: "Valle Central", lat: 9.96, lon: -83.89, url: "https://www.imn.ac.cr/especial/estacionPotrero.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/potrerocerrado.html", coordinateNote: "Ubicación aproximada por localidad (Sartalillo, Potrero Cerrado (Oreamuno)); no es la posición exacta del sensor." },
  { id: "imn-utn", name: "Estación IMN · UTN, Balsa de Atenas", zone: "Valle Central", lat: 9.9749, lon: -84.3789, url: "https://www.imn.ac.cr/especial/estacionUTN.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/utn.html", coordinateNote: "Ubicación aproximada por localidad (UTN, Balsa de Atenas); no es la posición exacta del sensor." },
  { id: "imn-virazu", name: "Estación IMN · Volcán Irazú", zone: "Valle Central", lat: 9.9793, lon: -83.852, url: "https://www.imn.ac.cr/especial/estacionVirazu.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/virazu.html", coordinateNote: "Ubicación aproximada por localidad (Volcán Irazú); no es la posición exacta del sensor." },
  { id: "imn-cantagallo", name: "Estación IMN · Cantagallo (Pococí)", zone: "Caribe Norte", lat: 10.2297, lon: -83.7703, url: "https://www.imn.ac.cr/especial/estacionCantagallo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/cantagallo.html", coordinateNote: "Ubicación aproximada por cantón (Cantagallo (Pococí)); el sensor puede estar a varios kilómetros." },
  { id: "imn-roxana", name: "Estación IMN · Caramba Farms, Roxana (Pococí)", zone: "Caribe Norte", lat: 10.23, lon: -83.7, url: "https://www.imn.ac.cr/especial/estacionRoxana.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/roxana.html", coordinateNote: "Ubicación aproximada por localidad (Caramba Farms, Roxana (Pococí)); no es la posición exacta del sensor." },
  { id: "imn-earth", name: "Estación IMN · EARTH (Guácimo)", zone: "Caribe Norte", lat: 10.2129, lon: -83.6879, url: "https://www.imn.ac.cr/especial/estacionearth.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/earth.html", coordinateNote: "Ubicación aproximada por localidad (EARTH (Guácimo)); no es la posición exacta del sensor." },
  { id: "imn-frutadepan", name: "Estación IMN · Fruta de Pan (Pococí)", zone: "Caribe Norte", lat: 10.25, lon: -83.65, url: "https://www.imn.ac.cr/especial/estacionFrutadePan.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/frutadepan.html", coordinateNote: "Ubicación aproximada por cantón (Fruta de Pan (Pococí)); el sensor puede estar a varios kilómetros." },
  { id: "imn-guapiles", name: "Estación IMN · Pococí, Guápiles", zone: "Caribe Norte", lat: 10.2167, lon: -83.7833, url: "https://www.imn.ac.cr/especial/estacionGuapiles.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/guapiles.html", coordinateNote: "Ubicación aproximada por localidad (Pococí, Guápiles); no es la posición exacta del sensor." },
  { id: "imn-rainforest", name: "Estación IMN · Rain Forest, Braulio Carrillo", zone: "Caribe Norte", lat: 10.17, lon: -83.94, url: "https://www.imn.ac.cr/especial/estacionRainforest.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/rainforest.html", coordinateNote: "Ubicación aproximada por localidad (Rain Forest, Braulio Carrillo); no es la posición exacta del sensor." },
  { id: "imn-aeroplimon", name: "Estación IMN · Aeropuerto de Limón", zone: "Caribe Sur", lat: 9.9575, lon: -83.0219, url: "https://www.imn.ac.cr/especial/estacionlimon.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/aeroplimon.html", coordinateNote: "Ubicación aproximada por localidad (Aeropuerto de Limón); no es la posición exacta del sensor." },
  { id: "imn-catie", name: "Estación IMN · CATIE (Turrialba)", zone: "Caribe Sur", lat: 9.892, lon: -83.654, url: "https://www.imn.ac.cr/especial/estacionCatie.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/catie.html", coordinateNote: "Ubicación aproximada por localidad (CATIE (Turrialba)); no es la posición exacta del sensor." },
  { id: "imn-turrialba", name: "Estación IMN · Turrialba Centro", zone: "Caribe Sur", lat: 9.904, lon: -83.683, url: "https://www.imn.ac.cr/especial/estacionturri.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/turrialba.html", coordinateNote: "Ubicación aproximada por localidad (Turrialba Centro); no es la posición exacta del sensor." },
  { id: "imn-gavilancanta", name: "Estación IMN · Gavilán Canta, Bratsi (Talamanca)", zone: "Caribe Sur", lat: 9.5894, lon: -82.9823, url: "https://www.imn.ac.cr/especial/estacionGavilanCanta.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/gavilancanta.html", coordinateNote: "Ubicación aproximada por localidad (Gavilán Canta, Bratsi (Talamanca)); no es la posición exacta del sensor." },
  { id: "imn-hitoy", name: "Estación IMN · Hitoy Cerere", zone: "Caribe Sur", lat: 9.67, lon: -83.02, url: "https://www.imn.ac.cr/especial/estacionHitoy.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/hitoy.html", coordinateNote: "Ubicación aproximada por localidad (Hitoy Cerere); no es la posición exacta del sensor." },
  { id: "imn-manzanillo", name: "Estación IMN · Manzanillo (Talamanca)", zone: "Caribe Sur", lat: 9.6323, lon: -82.6574, url: "https://www.imn.ac.cr/especial/estacionManzanillo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/manzanillo.html", coordinateNote: "Ubicación aproximada por localidad (Manzanillo (Talamanca)); no es la posición exacta del sensor." },
  { id: "imn-marialuisa", name: "Estación IMN · María Luisa, Río Banano", zone: "Caribe Sur", lat: 9.9003, lon: -83.091, url: "https://www.imn.ac.cr/especial/estacionMariaLuisa.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/marialuisa.html", coordinateNote: "Ubicación aproximada por localidad (María Luisa, Río Banano); no es la posición exacta del sensor." },
  { id: "imn-juanvinas", name: "Estación IMN · Maravilla, Juan Viñas", zone: "Caribe Sur", lat: 9.894, lon: -83.7454, url: "https://www.imn.ac.cr/especial/estacionJuanVinas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/juanvinas.html", coordinateNote: "Ubicación aproximada por localidad (Maravilla, Juan Viñas); no es la posición exacta del sensor." },
  { id: "imn-guayabo", name: "Estación IMN · Monumento Nacional Guayabo", zone: "Caribe Sur", lat: 9.9733, lon: -83.6928, url: "https://www.imn.ac.cr/especial/estacionMGuayabo.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/guayabo.html", coordinateNote: "Ubicación aproximada por localidad (Monumento Nacional Guayabo); no es la posición exacta del sensor." },
  { id: "imn-ptovargas", name: "Estación IMN · Puerto Vargas (Cahuita)", zone: "Caribe Sur", lat: 9.737, lon: -82.813, url: "https://www.imn.ac.cr/especial/estacionPtovargas.html", tableUrl: "https://www.imn.ac.cr/especial/tablas/ptovargas.html", coordinateNote: "Ubicación aproximada por localidad (Puerto Vargas (Cahuita)); no es la posición exacta del sensor." },
  { id: "ucr-sanramon", name: "Estación UCR · Sede Occidente (San Ramón)", zone: "Valle Central Oeste", lat: 10.0877, lon: -84.4730, url: "https://tooji.cigefi.ucr.ac.cr/estaciones/SanRamon/Current_Vantage_Pro_Plus.htm", tableUrl: "https://tooji.cigefi.ucr.ac.cr/estaciones/SanRamon/Current_Vantage_Pro_Plus.htm", coordinateNote: "Ubicación aproximada de la localidad; no es la posición exacta del sensor." },
  { id: "ucr-piro", name: "Estación UCR · Piro (Osa)", zone: "Pacífico Sur", lat: 8.4200, lon: -83.3200, url: "https://tooji.cigefi.ucr.ac.cr/estaciones/Piro/Current_Vantage_Pro_Plus.htm", tableUrl: "https://tooji.cigefi.ucr.ac.cr/estaciones/Piro/Current_Vantage_Pro_Plus.htm", coordinateNote: "Ubicación aproximada de la localidad; no es la posición exacta del sensor." },
  { id: "ucr-siquirres", name: "Estación UCR · Siquirres", zone: "Caribe", lat: 10.0975, lon: -83.5075, url: "https://tooji.cigefi.ucr.ac.cr/estaciones/Siquirres/Current_Vantage_Pro_Plus.htm", tableUrl: "https://tooji.cigefi.ucr.ac.cr/estaciones/Siquirres/Current_Vantage_Pro_Plus.htm", coordinateNote: "Ubicación aproximada de la localidad; no es la posición exacta del sensor." },
  { id: "ucr-sanluis", name: "Estación UCR · Reserva Biológica San Luis (Monteverde)", zone: "Pacífico Norte", lat: 10.2830, lon: -84.7870, url: "https://tooji.cigefi.ucr.ac.cr/estaciones/SanLuis/", tableUrl: "https://tooji.cigefi.ucr.ac.cr/estaciones/SanLuis/", coordinateNote: "Ubicación aproximada de la localidad; no es la posición exacta del sensor." },
];

let homeLocation = null;
let locationRequestInProgress = false;
let destinationLocation = null;
let homeWeatherData = null;
let destinationWeatherData = null;

let map = null;
let mapReady = false;
let homeMarker = null;
let destinationMarker = null;

let radarMetadata = null;
let radarFrames = [];
const savedRadarSource = localStorage.getItem(SOURCE_STORAGE_KEY);
let radarSourceKey = "librewxr";
// "raintrack" = capa propia de lluvia medida por las estaciones del IMN (ver ratelayer.js).
let ownRainSelected = savedRadarSource !== "librewxr";
const savedLibrewxrColor = Number(localStorage.getItem(LIBREWXR_COLOR_STORAGE_KEY));
let librewxrColorScheme = LIBREWXR_PALETTES.includes(savedLibrewxrColor) ? savedLibrewxrColor : 10;
let radarFrameIndex = 0;
let radarPlayTimer = null;
let weatherRefreshTimer = null;
let imnRefreshTimer = null;
let cameraMarkers = [];
let activeMapDetailMarker = null;
let skylinePreviewRefreshTimer = null;
let cameraMonitorData = null;
let cameraMonitorTimer = null;
const dismissedCameraAlertIds = new Set();

let routeMode = "saved";
let routeWorkLocation = null;
let routeTemporaryDestination = null;
let routePickMode = null;
let routeStartMarker = null;
let routeEndMarker = null;
let routeIsVisible = false;

try {
  const savedWork = JSON.parse(localStorage.getItem(ROUTE_WORK_STORAGE_KEY) || "null");
  if (savedWork && Number.isFinite(Number(savedWork.lat)) && Number.isFinite(Number(savedWork.lon))) {
    routeWorkLocation = {
      name: String(savedWork.name || "Trabajo"),
      lat: Number(savedWork.lat),
      lon: Number(savedWork.lon),
      detail: String(savedWork.detail || "Destino laboral guardado")
    };
  }
} catch (error) {
  console.warn("No se pudo leer el destino laboral guardado:", error);
}

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

// Solo permite enlaces http(s); cualquier otro esquema (p. ej. javascript:) se descarta.
function safeHttpUrl(value, fallback = "") {
  try {
    const url = new URL(String(value ?? ""), window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : fallback;
  } catch (error) {
    return fallback;
  }
}

function setSystemStatus(message, kind = "ok") {
  const el = $("systemStatus");
  el.innerHTML = '<span class="status-dot"></span> ' + escapeHtml(message);
  el.style.color = kind === "error" ? "#fca5a5" : kind === "loading" ? "#7dd3fc" : "#4ade80";
  el.style.background = kind === "error" ? "rgba(127,29,29,.35)" : kind === "loading" ? "rgba(7,89,133,.35)" : "rgba(22,60,54,.8)";
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Respuesta HTTP " + response.status);
  return await response.json();
}

function formatLocalHour(isoString) {
  if (!isoString) return "--";
  const match = String(isoString).match(/T(\d{2}):(\d{2})/);
  if (!match) return String(isoString);
  const date = new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
  return new Intl.DateTimeFormat("es-CR", {
    hour: "numeric", minute: "2-digit", timeZone: "UTC"
  }).format(date);
}

function formatClockFromTimestamp(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString("es-CR", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Costa_Rica"
  });
}

function formatMillimeters(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

function formatDayLength(seconds) {
  const totalMinutes = Math.round(Number(seconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + " h " + String(minutes).padStart(2, "0") + " min";
}

function weatherInfo(code, isDay = true) {
  const c = Number(code);
  if (!isDay) {
    // De noche no se muestra sol: se usa la luna.
    if (c === 0) return { icon: "🌙", text: "Despejado" };
    if (c === 1) return { icon: "🌙", text: "Mayormente despejado" };
    if (c === 2) return { icon: "☁️", text: "Parcialmente nublado" };
  }
  if (c === 0) return { icon: "☀️", text: "Despejado" };
  if (c === 1) return { icon: "🌤️", text: "Mayormente despejado" };
  if (c === 2) return { icon: "⛅", text: "Parcialmente nublado" };
  if (c === 3) return { icon: "☁️", text: "Nublado" };
  if (c === 45 || c === 48) return { icon: "🌫️", text: "Neblina" };
  if ([51, 53, 55, 56, 57].includes(c)) return { icon: "🌦️", text: "Llovizna" };
  if ([61, 63, 65, 66, 67].includes(c)) return { icon: "🌧️", text: "Lluvia" };
  if ([71, 73, 75, 77].includes(c)) return { icon: "🌨️", text: "Nieve" };
  if ([80, 81, 82].includes(c)) return { icon: "🌦️", text: "Chubascos" };
  if ([85, 86].includes(c)) return { icon: "🌨️", text: "Chubascos de nieve" };
  if ([95, 96, 99].includes(c)) return { icon: "⛈️", text: "Tormenta eléctrica" };
  return { icon: "🌤️", text: "Condiciones variables" };
}

// ------------------------------------------------------------
// ENFOQUE EXCLUSIVO EN COSTA RICA
// ------------------------------------------------------------
function signedRingArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += (x1 * y2) - (x2 * y1);
  }
  return area / 2;
}

function orientGeoJsonRing(ring, counterClockwise) {
  const copy = ring.map(point => [Number(point[0]), Number(point[1])]);
  if (copy.length && (
    copy[0][0] !== copy[copy.length - 1][0] ||
    copy[0][1] !== copy[copy.length - 1][1]
  )) {
    copy.push([...copy[0]]);
  }
  const isCounterClockwise = signedRingArea(copy) > 0;
  if (isCounterClockwise !== counterClockwise) copy.reverse();
  return copy;
}

async function addCostaRicaFocusMask() {
  // Se utiliza el polígono de Costa Rica para ocultar visualmente el
  // resto del mapa. Si el servicio de límites no responde, los límites
  // de navegación siguen activos como protección alternativa.
  const boundary = await fetchJson(CR_BOUNDARY_URL);
  const feature = boundary.type === "FeatureCollection"
    ? boundary.features.find(item =>
        item.properties && (
          item.properties.adm0_a3 === "CRI" ||
          item.properties.sov_a3 === "CRI" ||
          item.properties.name === "Costa Rica"
        )
      )
    : boundary.type === "Feature" ? boundary : null;

  if (!feature || !feature.geometry) {
    throw new Error("El servicio no devolvió el límite de Costa Rica.");
  }

  const geometry = feature.geometry;
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];

  const countryOuterRings = polygons
    .map(polygon => polygon && polygon[0])
    .filter(ring => Array.isArray(ring) && ring.length >= 4)
    .map(ring => orientGeoJsonRing(ring, false));

  if (!countryOuterRings.length) {
    throw new Error("No se pudo interpretar el polígono de Costa Rica.");
  }

  // El anillo exterior cubre el mundo y los anillos interiores dejan
  // visible únicamente el territorio costarricense.
  const worldRing = orientGeoJsonRing([
    [-180, -85.051129],
    [180, -85.051129],
    [180, 85.051129],
    [-180, 85.051129],
    [-180, -85.051129]
  ], true);

  const maskFeature = {
    type: "Feature",
    properties: { name: "Fuera de Costa Rica" },
    geometry: {
      type: "Polygon",
      coordinates: [worldRing, ...countryOuterRings]
    }
  };

  map.addSource("raintrack-cr-mask-source", {
    type: "geojson",
    data: maskFeature
  });

  // Se agrega al final del estilo para cubrir carreteras y etiquetas
  // de países vecinos. El hueco del polígono deja ver Costa Rica.
  map.addLayer({
    id: "raintrack-cr-outside-mask",
    type: "fill",
    source: "raintrack-cr-mask-source",
    paint: {
      "fill-color": basemapMode === "dark" ? "#0b111c" : CR_MASK_COLOR,
      "fill-opacity": 0.985
    }
  });

  map.addSource("raintrack-cr-boundary-source", {
    type: "geojson",
    data: feature
  });

  map.addLayer({
    id: "raintrack-cr-boundary-line",
    type: "line",
    source: "raintrack-cr-boundary-source",
    paint: {
      "line-color": basemapMode === "dark" ? "#38bdf8" : "#0284c7",
      "line-width": 2,
      "line-opacity": 0.9
    }
  });
}

function countryFitPadding() {
  const width = map.getContainer().clientWidth || window.innerWidth;
  // En pantallas anchas se reserva espacio lateral para que el país
  // no quede diminuto dentro de un mapa panorámico.
  const side = width > 1000
    ? Math.round(width * 0.27)
    : Math.round(width * 0.06);

  return {
    top: 22,
    bottom: 22,
    left: side,
    right: side
  };
}

function showCostaRicaOverview(animate = true) {
  if (!map) return;
  map.fitBounds(CR_MAINLAND_BOUNDS, {
    padding: countryFitPadding(),
    duration: animate ? 650 : 0,
    maxZoom: 8.4
  });
}

// ------------------------------------------------------------
// MAPA OPENFREEMAP / MAPLIBRE
// ------------------------------------------------------------
function initMap() {
  if (!window.maplibregl) {
    $("mapStatusChip").textContent = "No se pudo cargar MapLibre. Comprueba tu conexión.";
    return;
  }

  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [-84.10, 9.75],
    zoom: 7.2,
    // Sin límites: se puede alejar, acercar y mover el mapa libremente.
    minZoom: 2,
    maxZoom: 22,
    renderWorldCopies: true,
    attributionControl: true,
    // En móviles: permitir mover el mapa arrastrando con un solo dedo.
    // El zoom con pellizco continúa funcionando con dos dedos.
    dragPan: true,
    touchZoomRotate: true,
    cooperativeGestures: false
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");

  map.on("load", async () => {
    mapReady = true;
    $("mapStatusChip").textContent = "Preparando mapa de Costa Rica…";

    try {
      await addCostaRicaFocusMask();
      $("mapStatusChip").textContent = "🇨🇷 Costa Rica · Mapa libre";
    } catch (error) {
      console.warn("No se pudo cargar el contorno de Costa Rica; se mantienen los límites de navegación:", error);
      $("mapStatusChip").textContent = "🇨🇷 Costa Rica · Mapa libre";
    }

    showCostaRicaOverview(false);
    updateMapMarkers();

    if (homeLocation) {
      map.flyTo({
        center: [homeLocation.lon, homeLocation.lat],
        zoom: 12,
        speed: 1.1
      });
    }

    loadRadarSource();
  });

  map.on("zoomend", updateZoomHint);
  map.on("error", (event) => {
    console.warn("MapLibre:", event && event.error ? event.error : event);
    if (event && event.sourceId === "raintrack-radar-source") {
      $("radarStatus").textContent = "Error al cargar mosaicos";
      $("radarStatus").className = "error-text";
      $("radarTime").textContent = "Revisa tu conexión o la disponibilidad del proveedor del radar.";
    }
  });

  map.on("click", (event) => {
    if (!routePickMode) return;
    const { lng, lat } = event.lngLat;
    const [west, south] = CR_NAVIGATION_BOUNDS[0];
    const [east, north] = CR_NAVIGATION_BOUNDS[1];
    if (lng < west || lng > east || lat < south || lat > north) {
      const hint = $("routePickHint");
      hint.firstChild.textContent = "Selecciona un punto dentro de Costa Rica. ";
      return;
    }

    const selected = {
      name: routePickMode === "work" ? "Trabajo · punto seleccionado" : "Destino temporal",
      lat,
      lon: lng,
      detail: "Coordenadas seleccionadas directamente en el mapa"
    };

    if (routeIsVisible) clearRouteLayers();
    $("routeResult").hidden = true;
    if (routePickMode === "work") {
      saveWorkRouteDestination(selected);
      $("routeWorkSearchInput").value = selected.name;
    } else {
      routeTemporaryDestination = selected;
      $("routeTempSearchInput").value = selected.name;
      $("routeTempSearchResults").innerHTML = '<p class="tiny success">Destino seleccionado en el mapa.</p>';
    }

    routePickMode = null;
    map.getCanvas().style.cursor = "";
    $("routePickHint").hidden = true;
  });

  // Si se rota el teléfono o cambia el tamaño de la ventana, se vuelve
  // a encuadrar Costa Rica solo cuando el usuario aún no ha interactuado.
  let userMovedMap = false;
  map.on("dragstart", () => { userMovedMap = true; });
  map.on("zoomstart", () => { userMovedMap = true; });
  window.addEventListener("resize", () => {
    if (mapReady && !userMovedMap) showCostaRicaOverview(false);
  });
}

function makeMarker(color, label) {
  const element = document.createElement("div");
  element.style.width = "15px";
  element.style.height = "15px";
  element.style.borderRadius = "50%";
  element.style.background = color;
  element.style.border = "3px solid white";
  element.style.boxShadow = "0 2px 9px rgba(0,0,0,.35)";
  const marker = new maplibregl.Marker({ element, anchor: "center" });
  marker.setPopup(new maplibregl.Popup({ offset: 12 }).setText(label));
  return marker;
}

function updateMapMarkers() {
  if (!mapReady) return;
  if (homeMarker) { homeMarker.remove(); homeMarker = null; }
  if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }

  if (homeLocation) {
    homeMarker = makeMarker("#16a34a", "Mi ubicación actual")
      .setLngLat([homeLocation.lon, homeLocation.lat]).addTo(map);
  }
  if (destinationLocation) {
    destinationMarker = makeMarker("#0284c7", destinationLocation.name)
      .setLngLat([destinationLocation.lon, destinationLocation.lat]).addTo(map);
  }
}

function startSkylinePreviewRefresh() {
  if (skylinePreviewRefreshTimer) clearInterval(skylinePreviewRefreshTimer);
  const images = document.querySelectorAll("#mapDetailContent img[data-skyline-preview]");
  images.forEach(img => {
    img.addEventListener("error", () => {
      img.hidden = true;
      const fallback = img.parentElement?.querySelector(".camera-popup-row-preview-offline");
      if (fallback) {
        fallback.hidden = false;
        fallback.textContent = "La previsualización no está disponible ahora. Puedes abrir la cámara original en SkylineWebcams.";
      }
    }, { once: true });
  });
  if (!images.length) return;
  skylinePreviewRefreshTimer = setInterval(() => {
    document.querySelectorAll("#mapDetailContent img[data-skyline-preview]").forEach(img => {
      const base = img.getAttribute("data-skyline-base");
      if (base) {
        img.hidden = false;
        const fallback = img.parentElement?.querySelector(".camera-popup-row-preview-offline");
        if (fallback) fallback.hidden = true;
        img.src = base + (base.includes("?") ? "&" : "?") + "rt=" + Date.now();
      }
    });
  }, 300000);
}

function showMapDetail({ eyebrow, title, subtitle, content, markerElement }) {
  const sheet = $("mapDetailSheet");
  if (skylinePreviewRefreshTimer) {
    clearInterval(skylinePreviewRefreshTimer);
    skylinePreviewRefreshTimer = null;
  }
  if (activeMapDetailMarker) activeMapDetailMarker.classList.remove("is-active");
  activeMapDetailMarker = markerElement || null;
  if (activeMapDetailMarker) activeMapDetailMarker.classList.add("is-active");

  $("mapDetailEyebrow").textContent = eyebrow || "DETALLE DEL MAPA";
  $("mapDetailTitle").textContent = title || "Información del sitio";
  $("mapDetailSubtitle").textContent = subtitle || "";
  $("mapDetailContent").innerHTML = content || "";
  $("mapShell")?.classList.add("has-map-detail");
  sheet.hidden = false;
  sheet.classList.remove("is-open");
  startSkylinePreviewRefresh();
  requestAnimationFrame(() => sheet.classList.add("is-open"));
}

function closeMapDetail() {
  const sheet = $("mapDetailSheet");
  if (!sheet) return;
  if (skylinePreviewRefreshTimer) {
    clearInterval(skylinePreviewRefreshTimer);
    skylinePreviewRefreshTimer = null;
  }
  sheet.classList.remove("is-open");
  sheet.hidden = true;
  $("mapShell")?.classList.remove("has-map-detail");
  if (activeMapDetailMarker) activeMapDetailMarker.classList.remove("is-active");
  activeMapDetailMarker = null;
}

$("mapDetailClose").addEventListener("click", closeMapDetail);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("mapDetailSheet").hidden) closeMapDetail();
});

function clearCameraMarkers() {
  closeMapDetail();
  cameraMarkers.forEach(marker => marker.remove());
  cameraMarkers = [];
}

function cameraDisplayName(item) {
  const original = String(item.camera_name || "").trim();
  const groupTitle = new RegExp("\\b(?:las?\\s+)?(?:\\d+\\s+)?c[aá]maras?\\s+de\\b", "i").test(original);
  if (original && !groupTitle) return original;

  let slug = String(item.id || "");
  const sitePrefix = String(item.site_slug || "") + "-";
  if (sitePrefix !== "-" && slug.startsWith(sitePrefix)) slug = slug.slice(sitePrefix.length);
  if (sitePrefix !== "-" && slug.startsWith(sitePrefix)) slug = slug.slice(sitePrefix.length);
  if (!slug || slug === "default") return "Vista general del sitio";

  const aliases = { diria: "Diriá", witchsrock: "Witch's Rock", poas: "Poás", irazu: "Irazú" };
  return slug.split("-").filter(Boolean).map(part => {
    if (aliases[part.toLowerCase()]) return aliases[part.toLowerCase()];
    if (/^\\d+$/.test(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}


function cameraAvailabilityText(status) {
  return ({
    online: "Imagen reciente",
    delayed: "Imagen demorada",
    stale: "Sin actualización",
    offline: "Sin señal",
    not_available: "Sin imagen",
    unknown: "Antigüedad no verificable"
  })[status] || "Disponibilidad pendiente";
}

function cameraStatusForSite(siteSlug) {
  const rows = cameraMonitorData && Array.isArray(cameraMonitorData.cameras)
    ? cameraMonitorData.cameras.filter(item => item.site_slug === siteSlug)
    : [];
  if (!rows.length) return "pending";

  const skylineRows = rows.filter(item => item.source_type === "skylinewebcams");
  if (skylineRows.length) {
    const available = skylineRows.filter(item => item.availability_status === "online").length;
    if (available === skylineRows.length) return "online";
    if (available > 0) return "mixed";
    if (skylineRows.every(item => ["offline", "not_available"].includes(item.availability_status))) return "offline";
    return "pending";
  }

  if (rows.some(item => item.availability_status === "online" && item.image_quality_status === "usable")) return "online";
  if (rows.some(item => item.availability_status === "delayed")) return "delayed";
  if (rows.some(item => item.availability_status === "stale" || item.status === "stale")) return "stale";
  if (rows.some(item => item.availability_status === "offline" || item.status === "offline")) return "offline";
  if (rows.some(item => item.status === "low_visibility" || item.image_quality_status === "low_visibility")) return "low_visibility";
  return "pending";
}

function cameraAlertKey(item) {
  const kind = item.alert_type === "station" ? "station" : "camera";
  const id = item.station_id || item.id || item.site_slug || item.site_name || item.camera_name || "alert";
  return kind + ":" + id;
}

function stationShortName(item) {
  return String(item.station_name || item.site_name || "Estación IMN").replace(/^Estación IMN\s*·\s*/, "");
}

// Estación más cálida y más fría del momento (solo lecturas recientes y plausibles).
function computeTempExtremes() {
  const rows = cameraMonitorData && Array.isArray(cameraMonitorData.stations) ? cameraMonitorData.stations : [];
  const valid = rows.filter(item => item.availability_status === "online" && item.temperature_c != null
    && Number.isFinite(Number(item.temperature_c)) && Number(item.temperature_c) > -5 && Number(item.temperature_c) < 45);
  if (valid.length < 2) return null;
  const sorted = [...valid].sort((a, b) => Number(a.temperature_c) - Number(b.temperature_c));
  return { low: sorted[0], high: sorted[sorted.length - 1] };
}

function renderCameraAlerts() {
  const stack = $("cameraAlertStack");
  if (!stack) return;
  const generatedAt = cameraMonitorData && cameraMonitorData.generated_at
    ? new Date(cameraMonitorData.generated_at)
    : null;
  const fresh = generatedAt && !Number.isNaN(generatedAt.getTime())
    && (Date.now() - generatedAt.getTime()) <= 80 * 60 * 1000;
  // La lluvia se informa solo con estaciones del IMN (mediciones); las cámaras no generan alertas.
  const active = (fresh && cameraMonitorData && Array.isArray(cameraMonitorData.station_alerts)
    ? cameraMonitorData.station_alerts.filter(item =>
        item.rain_last_hour_mm > 0 &&
        item.availability_status === "online"
      )
    : [])
    .filter(item => !dismissedCameraAlertIds.has(cameraAlertKey(item)));

  const extremes = $("tempToggle").checked ? computeTempExtremes() : null;
  const tempKeys = extremes ? ["temp:high", "temp:low"].filter(k => !dismissedCameraAlertIds.has(k)) : [];

  if (!active.length && !tempKeys.length) {
    stack.hidden = true;
    stack.innerHTML = "";
    return;
  }

  stack.hidden = false;
  const link = item => escapeHtml(safeHttpUrl(item.page_url, "https://www.imn.ac.cr/"));
  const rainChips = active.slice(0, 8).map(item => {
    const mm = Number(item.rain_last_hour_mm).toFixed(1);
    return `<a class="rain-chip" href="${link(item)}" target="_blank" rel="noopener">🌧️ <b>${escapeHtml(stationShortName(item))}</b> ${mm} mm/h</a>`;
  });
  const tempChips = tempKeys.map(key => {
    const item = key === "temp:high" ? extremes.high : extremes.low;
    const icon = key === "temp:high" ? "🔥 Más cálida" : "❄️ Más fría";
    return `<a class="rain-chip temp-chip" href="${link(item)}" target="_blank" rel="noopener">${icon}: <b>${escapeHtml(stationShortName(item))}</b> ${Number(item.temperature_c).toFixed(1)}°C</a>`;
  });
  const chips = tempChips.concat(rainChips).join("");
  const label = active.length && tempKeys.length ? "En vivo" : active.length ? "Lluvia medida" : "Temperatura";
  const keys = active.slice(0, 8).map(cameraAlertKey).concat(tempKeys).join("|");
  const count = active.length + tempKeys.length;
  // El contenido se duplica para que el desplazamiento hacia la derecha sea continuo.
  stack.innerHTML = `<div class="rain-ticker" role="status">
    <span class="rain-ticker-label">${label}</span>
    <div class="rain-ticker-window"><div class="rain-ticker-track" style="animation-duration:${Math.max(18, count * 9)}s"><div class="rain-ticker-set">${chips}</div><div class="rain-ticker-set" aria-hidden="true">${chips}</div></div></div>
    <button class="rain-ticker-close" type="button" data-dismiss-camera-alert="${escapeHtml(keys)}" aria-label="Ocultar avisos" title="Ocultar">×</button>
  </div>`;
}

$("cameraAlertStack").addEventListener("click", event => {
  const closeButton = event.target.closest("[data-dismiss-camera-alert]");
  if (!closeButton) return;
  closeButton.getAttribute("data-dismiss-camera-alert").split("|").forEach(key => dismissedCameraAlertIds.add(key));
  renderCameraAlerts();
});

async function loadCameraMonitoringData() {
  try {
    const response = await fetch("camera-alerts.json?rt=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("No existe camera-alerts.json o GitHub Pages aún no lo publicó.");
    cameraMonitorData = await response.json();
    renderCameraAlerts();
    if (mapReady && ownRainSelected) showOwnRainSource();
    if (mapReady && ($("camerasToggle").checked || $("stationsToggle").checked || $("tempToggle").checked)) addCameraMarkers();
  } catch (error) {
    console.info("Monitor visual de cámaras pendiente:", error.message);
    renderCameraAlerts();
  }
}

function temperatureColor(t) {
  if (t < 16) return "#2563eb";
  if (t < 20) return "#0891b2";
  if (t < 24) return "#16a34a";
  if (t < 28) return "#ca8a04";
  if (t < 32) return "#ea580c";
  return "#dc2626";
}

function addCameraMarkers() {
  if (!mapReady) return;
  clearCameraMarkers();
  const showCameras = $("camerasToggle").checked;
  const tempMode = $("tempToggle").checked;
  const showStations = $("stationsToggle").checked || tempMode;
  const extremesNow = tempMode ? computeTempExtremes() : null;
  if (!showCameras && !showStations) return;

  (showCameras ? PUBLIC_CAMERAS : []).forEach(camera => {
    const status = cameraStatusForSite(camera.slug);
    const allSiteCameras = cameraMonitorData && Array.isArray(cameraMonitorData.cameras)
      ? cameraMonitorData.cameras.filter(item => item.site_slug === camera.slug)
      : [];
    const hasIndividualCameras = allSiteCameras.some(item => !String(item.id || "").endsWith("-default"));
    const siteCameras = hasIndividualCameras
      ? allSiteCameras.filter(item => {
          const isGenericDefault = String(item.id || "").endsWith("-default") &&
            new RegExp("\\b(?:las?\\s+)?(?:\\d+\\s+)?c[aá]maras?\\s+de\\b", "i").test(String(item.camera_name || ""));
          return !isGenericDefault;
        })
      : allSiteCameras;
    const isSkylineSite = camera.slug.startsWith("skyline-");
    const element = document.createElement("button");
    element.type = "button";
    element.className = "camera-marker " + status + (isSkylineSite ? " skyline-marker" : "");
    element.textContent = isSkylineSite && siteCameras.length > 1
      ? String(siteCameras.length)
      : status === "offline" ? "×" : status === "stale" ? "⌛" : status === "low_visibility" ? "?" : "📷";
    element.setAttribute("aria-label", "Abrir cámaras: " + camera.name);

    const recentCount = siteCameras.filter(item => item.availability_status === "online").length;
    const evaluableCount = siteCameras.filter(item =>
      item.availability_status === "online" && item.image_quality_status === "usable"
    ).length;
    const notEvaluableCount = siteCameras.filter(item =>
      item.status === "low_visibility" || item.image_quality_status === "low_visibility"
    ).length;
    const offlineCount = siteCameras.filter(item => ["offline", "not_available"].includes(item.availability_status)).length;
    const delayedCount = siteCameras.filter(item => item.availability_status === "delayed").length;
    const staleCount = siteCameras.filter(item => item.availability_status === "stale").length;
    const skylineCount = siteCameras.filter(item => item.source_type === "skylinewebcams").length;
    const skylineAvailableCount = siteCameras.filter(item =>
      item.source_type === "skylinewebcams" && item.availability_status === "online"
    ).length;
    const externalLinkCount = siteCameras.filter(item => item.source_type === "external_link").length;
    const cameraSummary = externalLinkCount === siteCameras.length && externalLinkCount
      ? [`${externalLinkCount} ${externalLinkCount === 1 ? "cámara" : "cámaras"} de video en vivo`, "estado no verificable desde RainTrack"]
      : skylineCount === siteCameras.length && skylineCount
      ? [
          `${skylineCount} ${skylineCount === 1 ? "cámara SkylineWebcams" : "cámaras SkylineWebcams"}`,
          `${skylineAvailableCount} disponibles`,
          skylineCount - skylineAvailableCount ? `${skylineCount - skylineAvailableCount} sin conexión o sin verificar` : ""
        ].filter(Boolean)
      : siteCameras.length
        ? [
            `${siteCameras.length} ${siteCameras.length === 1 ? "cámara" : "cámaras"}`,
            `${evaluableCount} con imagen reciente`,
            notEvaluableCount ? `${notEvaluableCount} sin imagen legible` : "",
            offlineCount ? `${offlineCount} sin señal` : "",
            delayedCount ? `${delayedCount} demoradas` : "",
            staleCount ? `${staleCount} desactualizadas` : ""
          ].filter(Boolean)
        : ["Sin detalle individual disponible"];

    const cameraRows = siteCameras.slice(0, 10).map(item => {
      const availabilityStatus = item.availability_status || "unknown";
      const availability = cameraAvailabilityText(availabilityStatus);
      const isSkylineCamera = item.source_type === "skylinewebcams";
      const isExternalLink = item.source_type === "external_link";
      const statusLabel = isExternalLink
        ? "Video en vivo en la fuente"
        : isSkylineCamera
        ? availabilityStatus === "online" ? "Imagen externa disponible" : availabilityStatus === "offline" ? "Fuera de línea en Skyline" : "Estado sin verificar"
        : item.status === "low_visibility" || item.image_quality_status === "low_visibility"
          ? "Imagen oscura o sin detalle"
          : availability;
      const icon = isExternalLink
        ? "↗"
        : isSkylineCamera
        ? availabilityStatus === "online" ? "↗" : "×"
        : item.status === "offline" || availabilityStatus === "offline" ? "×" : item.status === "low_visibility" ? "?" : "•";
      const age = item.image_age_minutes != null && Number.isFinite(Number(item.image_age_minutes))
        ? Math.round(Number(item.image_age_minutes)) + " min"
        : "";
      const recovered = item.recovered ? " · Recuperada" : "";
      const stateClass = item.status === "low_visibility"
        ? item.status
        : ["online", "offline", "delayed", "stale"].includes(availabilityStatus) ? availabilityStatus : "unknown";
      const sourceLink = item.page_url
        ? `<a href="${escapeHtml(safeHttpUrl(item.page_url, "#"))}" target="_blank" rel="noopener">${isExternalLink ? "Abrir video en vivo ↗" : isSkylineCamera ? (item.live_video_page ? "Abrir video en vivo ↗" : "Abrir en SkylineWebcams ↗") : item.source_type === "ovsicori" ? "Abrir fuente OVSICORI ↗" : "Abrir cámara ↗"}</a>`
        : "";
      const previewMarkup = isSkylineCamera
        ? availabilityStatus === "online" && item.preview_url
          ? `<div class="camera-popup-row-preview-wrap">
              <img class="camera-popup-row-preview" data-skyline-preview data-skyline-base="${escapeHtml(item.preview_url)}" src="${escapeHtml(item.preview_url)}?rt=${Date.now()}" alt="Previsualización oficial de ${escapeHtml(cameraDisplayName(item))}" loading="lazy">
              <span class="camera-popup-row-preview-offline" hidden>La previsualización no está disponible ahora. Puedes abrir la cámara original en SkylineWebcams.</span>
            </div>`
          : `<div class="camera-popup-row-preview-wrap"><span class="camera-popup-row-preview-offline">${availabilityStatus === "offline" ? "SkylineWebcams indica que esta cámara está fuera de línea. No se muestra una captura anterior." : "No se pudo verificar la cámara; no se muestra una imagen posiblemente desactualizada."}</span></div>`
        : "";
      return `<div class="camera-popup-row">
        <div class="camera-popup-row-main">
          <strong class="camera-popup-row-title">${escapeHtml(cameraDisplayName(item))}</strong>
          <small class="camera-popup-row-detail">${escapeHtml(isExternalLink ? "Sin miniatura ni verificación de estado · ábrela para saber si transmite" : isSkylineCamera ? (item.live_video_page ? "Video en vivo en la fuente · miniatura en RainTrack" : "Vista previa externa · no analizada") : [age, recovered.trim()].filter(Boolean).join(" "))}</small>
        </div>
        <span class="camera-popup-row-state ${stateClass}">${icon} ${escapeHtml(statusLabel)}</span>
        ${previewMarkup}
        ${sourceLink}
      </div>`;
    }).join("");
    const hasOnlyExternalLinks = siteCameras.length > 0 && siteCameras.every(item => item.source_type === "external_link");
    const hasSkylineCameras = siteCameras.some(item => item.source_type === "skylinewebcams");
    const hasLiveSkylineVideo = siteCameras.some(item => item.source_type === "skylinewebcams" && item.live_video_page === true);
    const summary = hasOnlyExternalLinks
      ? "Esta cámara solo ofrece video en vivo en su página original. RainTrack no puede comprobar si está transmitiendo ni mostrar una miniatura; ábrela para verla cuando esté disponible."
      : hasLiveSkylineVideo
      ? "La página original de SkylineWebcams ofrece video en vivo. RainTrack muestra una miniatura y verifica que la ficha esté disponible; todavía no reproduce ni analiza el flujo de video. Abre la cámara original para verla en directo."
      : hasSkylineCameras
        ? "RainTrack muestra una previsualización externa de SkylineWebcams y verifica la disponibilidad de la ficha. La imagen de previsualización no genera alertas de lluvia."
      : status === "low_visibility"
        ? "La imagen está oscura, tiene interferencia o no ofrece detalle suficiente."
        : status === "offline"
          ? "Las cámaras de este sitio no están proporcionando imágenes."
          : status === "stale"
            ? "Las imágenes disponibles no se han actualizado recientemente."
            : status === "delayed"
              ? "Hay imágenes demoradas."
              : "Imagen reciente. RainTrack no analiza la lluvia en las cámaras: consulta el radar y las estaciones del IMN.";
    const popupHtml = `<div class="camera-popup">
      <div class="camera-popup-summary">${cameraSummary.map(value => `<span>${escapeHtml(value)}</span>`).join("")}</div>
      <div class="camera-popup-status">${escapeHtml(summary)}</div>
      ${cameraRows ? `<div class="camera-popup-list">${cameraRows}</div>` : ""}
      <small class="camera-popup-note">Las imágenes son evidencia visual, no una medición de lluvia. Contrasta siempre con radar y estaciones.</small>
      <a class="camera-popup-site-link" href="${escapeHtml(safeHttpUrl(camera.url, "#"))}" target="_blank" rel="noopener">Abrir página del sitio ↗</a>
    </div>`;
    const marker = new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat([camera.lon, camera.lat])
      .addTo(map);
    element.addEventListener("click", () => showMapDetail({
      eyebrow: "CÁMARAS PÚBLICAS",
      title: camera.name,
      subtitle: camera.zone + " · " + camera.detail,
      content: popupHtml,
      markerElement: element
    }));
    cameraMarkers.push(marker);
  });

  const stationRows = cameraMonitorData && Array.isArray(cameraMonitorData.stations)
    ? cameraMonitorData.stations
    : [];
  (showStations ? PUBLIC_STATIONS : []).forEach(station => {
    const rowForDead = stationRows.find(item => item.id === station.id);
    if (rowForDead && rowForDead.dead) return;
    if (station.externalWidget) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "camera-marker station-marker pending";
      element.textContent = "🌡️";
      element.setAttribute("aria-label", "Abrir panel meteorológico: " + station.name);
      const popupHtml = `<div class="camera-popup">
        <div class="camera-popup-status">Panel público enlazado desde Parapente Pura Vida. Referencia externa. Su última lectura es de noviembre de 2025 (la estación no transmite), por eso no se usa para la lluvia. Si vuelve a transmitir, RainTrack la incluirá solo con datos de menos de 60 min.</div>
        <iframe class="weatherlink-frame" src="${escapeHtml(station.url)}" title="Condiciones actuales NEOJACO WeatherLink" loading="lazy" referrerpolicy="no-referrer"></iframe>
        <div class="camera-popup-links">
          <a class="camera-popup-link" href="${escapeHtml(station.url)}" target="_blank" rel="noopener">Abrir panel WeatherLink ↗</a>
        </div>
      </div>`;
      const marker = new maplibregl.Marker({ element, anchor: "center" })
        .setLngLat([station.lon, station.lat])
        .addTo(map);
      element.addEventListener("click", () => showMapDetail({
        eyebrow: "PANEL METEOROLÓGICO EXTERNO",
        title: station.name,
        subtitle: station.zone + " · Ubicación de referencia de Jacó",
        content: popupHtml,
        markerElement: element
      }));
      cameraMarkers.push(marker);
      return;
    }

    const observation = stationRows.find(item => item.id === station.id);
    const availability = observation ? observation.availability_status : "not_available";
    const rainObserved = !!(observation && observation.rain_observed &&
      availability === "online");
    const tempValue = observation && observation.temperature_c != null ? Number(observation.temperature_c) : NaN;
    const tempUsable = Number.isFinite(tempValue) && (availability === "online" || availability === "delayed");
    // Solo temperatura: se omiten las estaciones sin lectura reciente.
    if (tempMode && !$("stationsToggle").checked && !tempUsable) return;
    const element = document.createElement("button");
    element.type = "button";
    element.className = "camera-marker station-marker " + (rainObserved ? "rain" : availability);
    element.textContent = rainObserved ? "🌧️" : "🌡️";
    if (tempMode && tempUsable) {
      element.className = "camera-marker station-marker temp" + (rainObserved ? " rainy" : "");
      element.textContent = Math.round(tempValue) + "°";
      element.style.background = temperatureColor(tempValue);
      if (extremesNow && extremesNow.high.id === station.id) element.classList.add("extreme-hi");
      if (extremesNow && extremesNow.low.id === station.id) element.classList.add("extreme-lo");
    }
    element.setAttribute("aria-label", "Abrir estación meteorológica: " + station.name);

    const rainHour = observation && observation.rain_last_hour_mm != null && Number.isFinite(Number(observation.rain_last_hour_mm))
      ? Number(observation.rain_last_hour_mm).toFixed(1) + (observation.data_source === "ucr_cigefi_vantage" ? " mm/h" : " mm")
      : "Sin lectura";
    const rainDayRaw = observation && fromUcrRow(observation) ? observation.rain_today_mm : (observation && observation.rain_since_7am_mm);
    const rainDay = rainDayRaw != null && Number.isFinite(Number(rainDayRaw))
      ? Number(rainDayRaw).toFixed(1) + " mm"
      : "Sin lectura";
    const temperature = observation && observation.temperature_c != null && Number.isFinite(Number(observation.temperature_c))
      ? Number(observation.temperature_c).toFixed(1) + " °C"
      : "Sin lectura";
    const wind = observation && observation.wind_speed_kmh != null && Number.isFinite(Number(observation.wind_speed_kmh))
      ? Number(observation.wind_speed_kmh).toFixed(1) + " km/h"
      : "Sin lectura";
    const windDirection = observation && observation.wind_direction_deg != null && Number.isFinite(Number(observation.wind_direction_deg))
      ? Number(observation.wind_direction_deg).toFixed(0) + "°"
      : "Sin lectura";
    const windGust = observation && observation.wind_gust_kmh != null && Number.isFinite(Number(observation.wind_gust_kmh))
      ? Number(observation.wind_gust_kmh).toFixed(1) + " km/h"
      : "Sin lectura";
    const dewPoint = observation && observation.dew_point_c != null && Number.isFinite(Number(observation.dew_point_c))
      ? Number(observation.dew_point_c).toFixed(1) + " °C"
      : "Sin lectura";
    const humidity = observation && observation.humidity_percent != null && Number.isFinite(Number(observation.humidity_percent))
      ? Math.round(Number(observation.humidity_percent)) + "%"
      : "Sin lectura";
    const updated = observation && observation.image_timestamp
      ? new Date(observation.image_timestamp).toLocaleString("es-CR")
      : "Hora de observación no identificada";
    const obsAgeMin = observation && observation.image_timestamp
      ? Math.max(0, Math.round((Date.now() - new Date(observation.image_timestamp).getTime()) / 60000))
      : null;
    const updatedAge = obsAgeMin == null ? "" : obsAgeMin < 90 ? ` (hace ${obsAgeMin} min)` : ` (hace ${Math.round(obsAgeMin / 60)} h)`;
    const stationStatus = observation ? cameraAvailabilityText(availability) : "Esperando primera lectura";
    const isUcr = !!(observation && observation.data_source === "ucr_cigefi_vantage");
    const fromUcr = !!(observation && String(observation.data_source || "").startsWith("ucr_"));
    const stationMessage = rainObserved
      ? (isUcr ? "La estación de la UCR registra lluvia en este momento." : "La estación registró precipitación en la última hora.")
      : observation && availability === "stale"
        ? "La tabla del IMN está desactualizada; no se usa para alertas actuales."
        : fromUcr
          ? (isUcr ? "Lectura de la estación de la UCR (CIGEFI), actualizada cada 5 min; la lluvia es la intensidad actual." : "Registro por minuto de la estación de la UCR (CIGEFI); la lluvia es la suma de la última hora.")
        : observation && observation.data_source === "imn_html_table"
          ? "Lectura instrumental obtenida directamente de la tabla HTML oficial del IMN."
          : "Lectura del IMN pendiente de verificación.";
    const popupHtml = `<div class="camera-popup">
      <div class="camera-popup-status">${escapeHtml(stationMessage)}</div>
      <div class="station-metrics">
        <div class="station-metric"><span>${isUcr ? "Lluvia · intensidad ahora" : "Lluvia · última hora"}</span><strong>${escapeHtml(rainHour)}</strong></div>
        <div class="station-metric"><span>${fromUcr ? "Acumulada hoy" : "Acumulada desde 7 a. m."}</span><strong>${escapeHtml(rainDay)}</strong></div>
        <div class="station-metric"><span>Temperatura</span><strong>${escapeHtml(temperature)}</strong></div>
        <div class="station-metric"><span>Humedad</span><strong>${escapeHtml(humidity)}</strong></div>
        <div class="station-metric"><span>Viento</span><strong>${escapeHtml(wind)}</strong></div>
        <div class="station-metric"><span>Ráfaga máxima</span><strong>${escapeHtml(windGust)}</strong></div>
        <div class="station-metric"><span>Dirección del viento</span><strong>${escapeHtml(windDirection)}</strong></div>
        <div class="station-metric"><span>Punto de rocío</span><strong>${escapeHtml(dewPoint)}</strong></div>
      </div>
      <small class="camera-popup-meta">Estado: ${escapeHtml(stationStatus)} · Observación: ${escapeHtml(updated + updatedAge)} · ${fromUcr ? "Datos de la UCR (CIGEFI)" : "Datos preliminares del IMN"}</small>
      <div class="camera-popup-links">
        <a class="camera-popup-link" href="${escapeHtml(station.tableUrl || station.url)}" target="_blank" rel="noopener">Consultar datos oficiales ↗</a>
        ${station.url && station.url !== station.tableUrl ? '<a class="camera-popup-link" href="' + escapeHtml(station.url) + '" target="_blank" rel="noopener">Ver panel gráfico ↗</a>' : ""}
      </div>
    </div>`;
    const marker = new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat([station.lon, station.lat])
      .addTo(map);
    element.addEventListener("click", () => showMapDetail({
      eyebrow: "ESTACIÓN METEOROLÓGICA",
      title: station.name,
      subtitle: station.zone + " · Fuente oficial IMN" + (station.coordinateNote ? " · " + station.coordinateNote : ""),
      content: popupHtml,
      markerElement: element
    }));
    cameraMarkers.push(marker);
  });
}

function refreshImnImage() {
  const productKey = $('imnProduct').value;
  const product = IMN_PRODUCTS[productKey];
  if (!product) return;

  const image = $('imnMapImage');
  const status = $('imnMapStatus');
  $('imnCardTitle').textContent = "IMN · " + product.label;
  $('imnSourceLink').href = safeHttpUrl(product.source, "#");
  image.hidden = true;
  status.textContent = "Solicitando imagen al IMN…";
  status.className = "imn-card-status loading";

  image.onload = () => {
    image.hidden = false;
    const consulted = new Date().toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" });
    status.textContent = "Imagen recibida · Consultada a las " + consulted + ". Revisa la fecha/hora impresa dentro del producto para conocer su observación.";
    status.className = "imn-card-status success";
  };
  image.onerror = () => {
    image.hidden = true;
    status.textContent = "No se pudo cargar esta imagen desde el IMN. Usa el enlace oficial para comprobar su disponibilidad.";
    status.className = "imn-card-status error-text";
  };

  const separator = product.url.includes("?") ? "&" : "?";
  image.src = product.url + separator + "raintrack=" + Date.now();
}

function setImnVisibility(visible) {
  $('imnMapCard').hidden = !visible;
  if (visible) refreshImnImage();
}

function updateZoomHint() {
  if (!map || !mapReady) return;
  const config = RADAR_SOURCES[radarSourceKey];
  const zoom = map.getZoom();
  if (zoom > config.maxZoom + 0.2) {
    $("mapStatusChip").textContent = "Zoom " + zoom.toFixed(1) + " · La fuente " + config.label + " no aporta más detalle nativo al acercar.";
  }
}

function syncBasemapButton() {
  const b = $("basemapQuick");
  if (!b) return;
  b.textContent = basemapMode === "dark" ? "🌙" : "☀️";
  b.title = basemapMode === "dark" ? "Fondo oscuro · toca para fondo claro" : "Fondo claro · toca para fondo oscuro";
}

function fromUcrRow(row) {
  return !!(row && String(row.data_source || "").startsWith("ucr_"));
}

function applyBasemap(mode) {
  basemapMode = mode === "light" ? "light" : "dark";
  syncBasemapButton();
  try { localStorage.setItem(BASEMAP_STORAGE_KEY, basemapMode); } catch (e) {}
  $("mapShell").classList.toggle("map-dark", basemapMode === "dark");
  if (!map || !mapReady) return;
  map.setStyle(MAP_STYLES[basemapMode], { diff: false });
  map.once("style.load", async () => {
    try { await addCostaRicaFocusMask(); } catch (error) { console.warn("Contorno de Costa Rica no disponible:", error); }
    if (lastRouteDraw) { try { drawRouteOnMap(lastRouteDraw.route, lastRouteDraw.origin, lastRouteDraw.destination); } catch (e) {} }
    if (!ownRainSelected && radarFrames.length) showRadarFrame(radarFrameIndex);
  });
}

function removeRadarLayer() {
  if (!mapReady) return;
  if (map.getLayer("raintrack-radar-layer")) map.removeLayer("raintrack-radar-layer");
  if (map.getSource("raintrack-radar-source")) map.removeSource("raintrack-radar-source");
}

function setRadarTimeline(frames, allowAnimation = true) {
  radarFrames = frames;
  radarFrameIndex = 0;
  $("frameSlider").disabled = radarFrames.length <= 1;
  $("frameSlider").min = "0";
  $("frameSlider").max = String(Math.max(0, radarFrames.length - 1));
  $("frameSlider").value = "0";
  $("playRadar").disabled = radarFrames.length <= 1 || !allowAnimation;
  if (radarFrames.length <= 1 || !allowAnimation) stopRadarAnimation();
}

function radarTileUrl(frame, metadata, config) {
  const host = String(metadata.host || config.fallbackHost).replace(/\/$/, "");
  const path = String(frame.path || "");
  return host + path + "/256/{z}/{x}/{y}/" + librewxrColorScheme + "/" + config.smooth + "_" + config.snow + ".png";
}

function showOwnRainSource() {
  stopRadarAnimation();
  removeRadarLayer();
  radarFrames = [];
  $("frameSlider").disabled = true;
  $("playRadar").disabled = true;
  $("librewxrStyleControl").hidden = true;
  $("radarLegend").hidden = true;
  const gen = cameraMonitorData && cameraMonitorData.generated_at ? new Date(cameraMonitorData.generated_at) : null;
  const when = gen && !Number.isNaN(gen.getTime())
    ? gen.toLocaleTimeString("es-CR", { hour: "numeric", minute: "2-digit" }) : "esperando datos";
  $("radarStatus").textContent = "🌧️ Lluvia medida · IMN";
  $("radarStatus").className = "radar-title";
  const genAge = gen && !Number.isNaN(gen.getTime()) ? Math.max(0, Math.round((Date.now() - gen.getTime()) / 60000)) : null;
  $("radarTime").textContent = "Estaciones del IMN · lectura de las " + when + (genAge == null ? "" : " (hace " + genAge + " min)");
  $("frameLabel").textContent = "--";
  $("mapToolbar").classList.add("own-rain-mode");
  if (window.RainTrackOwnRain) { window.RainTrackOwnRain.rebuild(); window.RainTrackOwnRain.sync(); }
  const storms = window.RainTrackOwnRain ? window.RainTrackOwnRain.stormCount() : 0;
  const cellsNow = window.RainTrackOwnRain ? window.RainTrackOwnRain.cellCount() : 0;
  const stats = $("ownRainStats");
  stats.hidden = false;
  stats.innerHTML =
    `<span class="orc ${cellsNow ? "on" : ""}"><b>${cellsNow}</b> ${cellsNow === 1 ? "estación con lluvia" : "estaciones con lluvia"}</span>` +
    `<span class="orc ${storms ? "storm" : ""}"><b>${storms}</b> ${storms === 1 ? "tormenta" : "tormentas"}</span>` +
    `<span class="orc hint">Solo donde hay estación midiendo</span>`;
  $("mapStatusChip").textContent = storms
    ? "⛈️ " + storms + (storms === 1 ? " zona con tormenta" : " zonas con tormenta") + " · lluvia intensa medida"
    : cellsNow ? "🌧️ Lluvia medida en " + cellsNow + (cellsNow === 1 ? " estación" : " estaciones") : "☀️ Sin lluvia medida ahora · estaciones IMN";
  const stale = genAge != null && genAge > 30;
  $("radarTime").classList.toggle("warn", stale);
  if (stale && !cellsNow && !storms) {
    $("mapStatusChip").textContent = "⏳ Datos de hace " + (genAge >= 90 ? Math.round(genAge / 60) + " h" : genAge + " min") + " · pueden estar desactualizados";
  }
}

async function loadRadarSource() {
  if (!mapReady) return;
  stopRadarAnimation();

  if ($("radarSource").value === "raintrack") {
    localStorage.setItem(SOURCE_STORAGE_KEY, "raintrack");
    ownRainSelected = true;
    showOwnRainSource();
    return;
  }
  ownRainSelected = false;
  $("mapToolbar").classList.remove("own-rain-mode");
  $("ownRainStats").hidden = true;
  if (window.RainTrackOwnRain) window.RainTrackOwnRain.sync();

  const selectedSource = $("radarSource").value;
  radarSourceKey = RADAR_SOURCES[selectedSource] ? selectedSource : "librewxr";
  $("radarSource").value = radarSourceKey;
  localStorage.setItem(SOURCE_STORAGE_KEY, radarSourceKey);

  const config = RADAR_SOURCES[radarSourceKey];
  $("librewxrStyleControl").hidden = radarSourceKey !== "librewxr";
  $("librewxrColorScheme").value = String(librewxrColorScheme);
  $("radarStatus").textContent = "Consultando " + config.label + "…";
  $("radarStatus").className = "loading";
  $("radarTime").textContent = "Obteniendo imágenes recientes";
  $("mapStatusChip").textContent = "Consultando fuente meteorológica…";
  removeRadarLayer();

  try {
    $("radarLegend").hidden = false;

    const metadata = await fetchJson(config.metadataUrl);
    const past = Array.isArray(metadata.radar?.past) ? metadata.radar.past : [];
    // RainViewer mantiene únicamente imágenes observadas; LibreWXR también puede aportar nowcast.
    const future = radarSourceKey === "librewxr" && Array.isArray(metadata.radar?.nowcast)
      ? metadata.radar.nowcast : [];

    if (!past.length) throw new Error("La fuente no devolvió imágenes disponibles.");

    radarMetadata = metadata;
    radarFrames = [
      ...past.map(frame => ({ ...frame, frameType: "observed" })),
      ...future.map(frame => ({ ...frame, frameType: "forecast" }))
    ];

    radarFrameIndex = past.length - 1;
    $("frameSlider").disabled = radarFrames.length <= 1;
    $("frameSlider").min = "0";
    $("frameSlider").max = String(Math.max(0, radarFrames.length - 1));
    $("frameSlider").value = String(radarFrameIndex);
    $("playRadar").disabled = radarFrames.length <= 1;
    showRadarFrame(radarFrameIndex);

    const lastObserved = past[past.length - 1];
    $("radarStatus").textContent = "Catálogo de imágenes recibido · " + config.label;
    $("radarStatus").className = "muted";
    $("radarTime").textContent = "Último mosaico publicado: " + formatClockFromTimestamp(lastObserved.time);

    $("mapStatusChip").textContent = "LibreWXR · precipitación global estimada por satélite";
    $("radarSourceNote").innerHTML =
      'En Costa Rica, LibreWXR utiliza principalmente NOAA RRQPE, una <strong>estimación satelital infrarroja de precipitación</strong>, no una medición directa de radar terrestre. Tiene una cadencia aproximada de 10 minutos y una latencia mediana cercana a 17 minutos; puede subestimar lluvias cálidas o estratiformes. Su cobertura geográfica es más amplia, pero debe contrastarse con estaciones y avisos oficiales. Fuente: <a href="https://librewxr.net/" target="_blank" rel="noopener">LibreWXR</a>.';

    updateZoomHint();
  } catch (error) {
    console.error("Error al cargar fuente de precipitación:", error);
    removeRadarLayer();
    $("radarStatus").textContent = "Fuente no disponible";
    $("radarStatus").className = "error-text";
    $("radarTime").textContent = error && error.message
      ? error.message
      : "No se pudo obtener una imagen reciente.";
    $("mapStatusChip").textContent = "El mapa base sigue funcionando; la capa de precipitación no está disponible.";
    $("radarSourceNote").textContent = error && error.message
      ? error.message + " Revisa la clave, los permisos, el límite de solicitudes o la disponibilidad del proveedor."
      : "La fuente no respondió o no tiene mosaicos disponibles. La capa base del mapa sigue funcionando.";
    $("frameLabel").textContent = "--";
    $("frameSlider").disabled = true;
    $("playRadar").disabled = true;
  }
}

function showRadarFrame(index) {
  if (!mapReady || !radarMetadata || !radarFrames.length) return;
  const safeIndex = Math.max(0, Math.min(Number(index), radarFrames.length - 1));
  radarFrameIndex = safeIndex;
  const frame = radarFrames[safeIndex];
  const config = RADAR_SOURCES[radarSourceKey];

  removeRadarLayer();

  const tileUrl = radarTileUrl(frame, radarMetadata, config);
  map.addSource("raintrack-radar-source", {
    type: "raster",
    tiles: [tileUrl],
    tileSize: 256,
    minzoom: 0,
    maxzoom: config.maxZoom,
    attribution: ({
      librewxr: "Precipitation data: LibreWXR / NOAA RRQPE"
    })[radarSourceKey] || "Precipitation data"
  });

  const firstSymbol = map.getStyle().layers.find(layer => layer.type === "symbol");
  const layerDefinition = {
    id: "raintrack-radar-layer",
    type: "raster",
    source: "raintrack-radar-source",
    paint: {
      "raster-opacity": 0.76,
      "raster-fade-duration": 0,
      "raster-resampling": "nearest"
    }
  };

  if (firstSymbol) map.addLayer(layerDefinition, firstSymbol.id);
  else map.addLayer(layerDefinition);

  // Si hay una ruta solicitada, mantenerla visible por encima de la capa de radar.
  if (routeIsVisible) {
    if (firstSymbol) {
      if (map.getLayer("raintrack-route-casing")) map.moveLayer("raintrack-route-casing", firstSymbol.id);
      if (map.getLayer("raintrack-route-line")) map.moveLayer("raintrack-route-line", firstSymbol.id);
    } else {
      if (map.getLayer("raintrack-route-casing")) map.moveLayer("raintrack-route-casing");
      if (map.getLayer("raintrack-route-line")) map.moveLayer("raintrack-route-line");
    }
  }

  $("frameSlider").value = String(safeIndex);
  const latestObserved = radarFrames.filter(item => item.frameType === "observed").slice(-1)[0];
  if (frame.frameType === "forecast" && latestObserved) {
    const minutes = Math.max(0, Math.round((frame.time - latestObserved.time) / 60));
    $("frameLabel").textContent = "Proyección +" + minutes + " min";
    $("radarTime").textContent = "Proyección experimental · +" + minutes + " minutos";
  } else if (frame.frameType === "forecast") {
    const firstFrameTime = radarFrames[0] ? radarFrames[0].time : frame.time;
    const hours = Math.max(0, Math.round((frame.time - firstFrameTime) / 3600));
    $("frameLabel").textContent = hours === 0 ? "Pronóstico actual" : "Pronóstico +" + hours + " h";
    $("radarTime").textContent = "Pronóstico · " + formatClockFromTimestamp(frame.time);
  } else {
    $("frameLabel").textContent = formatClockFromTimestamp(frame.time);
    $("radarTime").textContent = "Imagen correspondiente a las " + formatClockFromTimestamp(frame.time);
  }
}

function stopRadarAnimation() {
  if (radarPlayTimer) {
    clearInterval(radarPlayTimer);
    radarPlayTimer = null;
  }
  const button = $("playRadar");
  if (button) button.textContent = "▶ Reproducir";
}

function toggleRadarAnimation() {
  if (radarPlayTimer) {
    stopRadarAnimation();
    return;
  }
  if (radarFrames.length < 2) return;
  $("playRadar").textContent = "Ⅱ Pausar";
  radarPlayTimer = setInterval(() => {
    let next = radarFrameIndex + 1;
    if (next >= radarFrames.length) next = 0;
    showRadarFrame(next);
  }, 750);
}

// ------------------------------------------------------------
// BÚSQUEDA DE LOCALIDADES DE COSTA RICA
// ------------------------------------------------------------
async function searchLocations(query) {
  const url = new URL(OPEN_METEO_GEOCODING);
  url.search = new URLSearchParams({
    name: query,
    count: "10",
    language: "es",
    countryCode: "CR",
    format: "json"
  }).toString();

  const data = await fetchJson(url.toString());
  return (data.results || []).filter(item => item.country_code === "CR");
}

function renderSearchResults(results) {
  const container = $("searchResults");
  container.innerHTML = "";

  if (!results.length) {
    container.innerHTML = '<p class="tiny">No encontré coincidencias. Prueba con el nombre del cantón o de la provincia.</p>';
    return;
  }

  results.forEach(result => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";

    const primary = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = result.name || "Localidad";
    const details = document.createElement("small");
    details.textContent = [result.admin2, result.admin1, result.country].filter(Boolean).join(" · ");
    primary.append(name, details);

    const arrow = document.createElement("span");
    arrow.textContent = "Consultar →";
    arrow.className = "accent small";

    button.append(primary, arrow);
    button.addEventListener("click", () => {
      const location = {
        name: result.name || "Destino",
        lat: Number(result.latitude),
        lon: Number(result.longitude),
        detail: [result.admin2, result.admin1, result.country].filter(Boolean).join(", ")
      };
      destinationLocation = location;
      $("searchInput").value = location.name;
      container.innerHTML = "";
      loadWeatherForLocation(location, "destination");
      if (mapReady) {
        map.flyTo({ center: [location.lon, location.lat], zoom: 10.5, speed: 1.15 });
        updateMapMarkers();
      }
      $("mapLocationChip").textContent = "📍 " + location.name;
    });

    container.appendChild(button);
  });
}

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  if (query.length < 2) return;

  $("searchButton").disabled = true;
  $("searchButton").textContent = "Buscando…";
  $("searchResults").innerHTML = '<p class="tiny loading">Buscando localidades de Costa Rica…</p>';

  try {
    const results = await searchLocations(query);
    renderSearchResults(results);
  } catch (error) {
    console.error(error);
    $("searchResults").innerHTML = '<p class="tiny error-text">No se pudo consultar el buscador. Revisa tu conexión e inténtalo de nuevo.</p>';
  } finally {
    $("searchButton").disabled = false;
    $("searchButton").textContent = "Buscar";
  }
});

// ------------------------------------------------------------
// RUTAS METEOROLÓGICAS
// ------------------------------------------------------------
function setRouteMode(mode) {
  if (routeIsVisible) clearRouteLayers();
  $("routeResult").hidden = true;
  routeMode = mode === "temporary" ? "temporary" : "saved";
  $("routeSavedMode").classList.toggle("active", routeMode === "saved");
  $("routeTempMode").classList.toggle("active", routeMode === "temporary");
  $("routeSavedSection").hidden = routeMode !== "saved";
  $("routeTempSection").hidden = routeMode !== "temporary";
  $("routeResult").hidden = true;
  updateSavedWorkStatus();
}

function updateSavedWorkStatus() {
  const status = $("savedWorkStatus");
  if (!status) return;
  if (routeWorkLocation) {
    status.innerHTML = `<strong>Trabajo guardado:</strong> ${escapeHtml(routeWorkLocation.name)}<br><span class="tiny">Este destino queda guardado en este teléfono.</span>`;
  } else {
    status.innerHTML = '<strong>Destino laboral sin configurar.</strong><br>Búscalo por localidad o marca el punto exacto en el mapa una sola vez.';
  }
}

function saveWorkRouteDestination(location) {
  routeWorkLocation = {
    name: String(location.name || "Trabajo"),
    lat: Number(location.lat),
    lon: Number(location.lon),
    detail: String(location.detail || "Destino laboral guardado")
  };
  localStorage.setItem(ROUTE_WORK_STORAGE_KEY, JSON.stringify(routeWorkLocation));
  if (routeIsVisible) clearRouteLayers();
  $("routeResult").hidden = true;
  updateSavedWorkStatus();
  $("routeWorkSearchResults").innerHTML = '<p class="tiny success">Destino laboral guardado en este teléfono.</p>';
  $("mapStatusChip").textContent = "Destino laboral guardado · " + routeWorkLocation.name;
}

function beginRouteMapPick(mode) {
  routePickMode = mode;
  $("routePickHint").hidden = false;
  $("routePickHint").innerHTML = `Toca el punto exacto en el mapa de Costa Rica. Puedes acercar el mapa para seleccionar mejor.<br><button class="btn ghost small-btn" id="routePickCancel" type="button" style="margin-top:7px">Cancelar selección</button>`;
  $("routePickCancel").addEventListener("click", cancelRouteMapPick);
  if (mapReady) map.getCanvas().style.cursor = "crosshair";
  $("mapStatusChip").textContent = mode === "work"
    ? "Selecciona en el mapa la ubicación exacta del trabajo"
    : "Selecciona en el mapa tu destino temporal";
  $("routePanel").hidden = false;
  $("routeToggle").setAttribute("aria-expanded", "true");
}

function cancelRouteMapPick() {
  routePickMode = null;
  $("routePickHint").hidden = true;
  if (mapReady) map.getCanvas().style.cursor = "";
}

async function searchRoutePlaces(query, resultContainerId, mode) {
  const container = $(resultContainerId);
  if (!query || query.trim().length < 2) {
    container.innerHTML = '<p class="tiny">Escribe al menos dos caracteres.</p>';
    return;
  }
  container.innerHTML = '<p class="tiny loading">Buscando localidades de Costa Rica…</p>';
  try {
    const results = await searchLocations(query.trim());
    container.innerHTML = "";
    if (!results.length) {
      container.innerHTML = '<p class="tiny">No encontré esa localidad. Para un punto exacto, utiliza «Elegir punto en el mapa».</p>';
      return;
    }
    results.forEach(result => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-search-result";
      const name = document.createElement("span");
      name.innerHTML = `<strong>${escapeHtml(result.name || "Localidad")}</strong><small>${escapeHtml([result.admin2, result.admin1, result.country].filter(Boolean).join(" · "))}</small>`;
      const choose = document.createElement("span");
      choose.className = "accent";
      choose.textContent = "Elegir →";
      button.append(name, choose);
      button.addEventListener("click", () => {
        const location = {
          name: result.name || "Destino",
          lat: Number(result.latitude),
          lon: Number(result.longitude),
          detail: [result.admin2, result.admin1, result.country].filter(Boolean).join(", ")
        };
        if (mode === "work") {
          saveWorkRouteDestination(location);
          $("routeWorkSearchInput").value = location.name;
        } else {
          routeTemporaryDestination = location;
          if (routeIsVisible) clearRouteLayers();
          $("routeResult").hidden = true;
          $("routeTempSearchInput").value = location.name;
          container.innerHTML = '<p class="tiny success">Destino seleccionado: ' + escapeHtml(location.name) + '.</p>';
        }
      });
      container.appendChild(button);
    });
  } catch (error) {
    console.error("Error al buscar destino de ruta:", error);
    container.innerHTML = '<p class="tiny error-text">No se pudo consultar el buscador. Inténtalo de nuevo.</p>';
  }
}

function clearRouteLayers() {
  if (!mapReady) return;
  ["raintrack-route-line", "raintrack-route-casing"].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource("raintrack-route-source")) map.removeSource("raintrack-route-source");
  if (routeStartMarker) { routeStartMarker.remove(); routeStartMarker = null; }
  if (routeEndMarker) { routeEndMarker.remove(); routeEndMarker = null; }
  routeIsVisible = false;
}

function closeRouteAnalysis() {
  clearRouteLayers();
  $("routeResult").hidden = true;
  $("routeResult").innerHTML = "";
  $("routePanel").hidden = true;
  $("routeToggle").setAttribute("aria-expanded", "false");
  $("routeToggle").textContent = "🧭 Rutas";
  cancelRouteMapPick();
  if (mapReady) showCostaRicaOverview(true);
  $("mapStatusChip").textContent = "🇨🇷 Costa Rica · Mapa normal";
}

function routeDistanceKm(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function sampleRouteLine(coordinates, distanceKm) {
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cumulative.push(cumulative[i - 1] + routeDistanceKm(coordinates[i - 1], coordinates[i]));
  }
  const total = cumulative[cumulative.length - 1] || distanceKm;
  const count = Math.min(ROUTE_WEATHER_SAMPLES_MAX, Math.max(3, Math.ceil(total / 12) + 1));
  const samples = [];

  for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
    const fraction = count === 1 ? 0 : sampleIndex / (count - 1);
    const target = total * fraction;
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < target) segment++;
    const startDistance = cumulative[segment - 1] || 0;
    const endDistance = cumulative[segment] || startDistance;
    const segmentFraction = endDistance === startDistance ? 0 : (target - startDistance) / (endDistance - startDistance);
    const start = coordinates[segment - 1] || coordinates[0];
    const end = coordinates[segment] || coordinates[coordinates.length - 1];
    samples.push({
      fraction,
      distanceAlongKm: total * fraction,
      coordinate: [
        start[0] + (end[0] - start[0]) * segmentFraction,
        start[1] + (end[1] - start[1]) * segmentFraction
      ]
    });
  }
  return samples;
}

async function getFreshGpsForRoute() {
  if (!navigator.geolocation) throw new Error("Este navegador no permite obtener ubicación GPS.");
  return await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({
        name: "Mi ubicación actual",
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        detail: "GPS leído al solicitar la ruta"
      }),
      error => reject(new Error(error.code === 1
        ? "Permite el acceso al GPS para analizar una ruta desde tu ubicación actual."
        : "No se pudo obtener tu GPS. Comprueba la ubicación del teléfono e inténtalo de nuevo.")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

async function getRouteWeather(location) {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: "precipitation,rain,showers,weather_code",
    hourly: "precipitation_probability,precipitation,rain,showers,weather_code",
    forecast_days: "2",
    timezone: "America/Costa_Rica"
  });
  return await fetchJson(OPEN_METEO_FORECAST + "?" + params.toString());
}

function nearestHourlyForecast(data, eta) {
  const times = data.hourly && data.hourly.time ? data.hourly.time : [];
  if (!times.length) return null;
  let bestIndex = 0;
  let bestDifference = Infinity;
  times.forEach((time, index) => {
    // Open-Meteo devuelve hora local sin offset cuando se especifica zona horaria.
    const date = new Date(time + "-06:00");
    const difference = Math.abs(date.getTime() - eta.getTime());
    if (difference < bestDifference) {
      bestDifference = difference;
      bestIndex = index;
    }
  });
  return {
    time: times[bestIndex],
    probability: Number(data.hourly.precipitation_probability?.[bestIndex] ?? 0),
    precipitation: Number(data.hourly.precipitation?.[bestIndex] ?? 0),
    rain: Number(data.hourly.rain?.[bestIndex] ?? 0),
    showers: Number(data.hourly.showers?.[bestIndex] ?? 0),
    weatherCode: Number(data.hourly.weather_code?.[bestIndex] ?? 0)
  };
}

function isRainWeatherCode(code) {
  return [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(Number(code));
}

function getRouteCurrentPrecipitationMm(current) {
  const values = ["precipitation", "rain", "showers"]
    .map(key => current?.[key])
    .filter(value => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : null;
}

function getRouteCurrentRainComponentMm(current) {
  const values = ["rain", "showers"]
    .map(key => current?.[key])
    .filter(value => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : null;
}

function formatRouteMillimeters(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number).toFixed(2) : "--";
}

function formatRouteDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function drawRouteOnMap(route, origin, destination) {
  lastRouteDraw = { route, origin, destination };
  clearRouteLayers();
  const feature = {
    type: "Feature",
    properties: {},
    geometry: route.geometry
  };
  map.addSource("raintrack-route-source", {
    type: "geojson",
    data: feature,
    lineMetrics: true
  });
  const firstSymbol = map.getStyle().layers.find(layer => layer.type === "symbol");
  const casing = {
    id: "raintrack-route-casing",
    type: "line",
    source: "raintrack-route-source",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#082f49", "line-width": 8, "line-opacity": 0.9 }
  };
  const line = {
    id: "raintrack-route-line",
    type: "line",
    source: "raintrack-route-source",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#38bdf8", "line-width": 5, "line-opacity": 0.98 }
  };
  if (firstSymbol) {
    map.addLayer(casing, firstSymbol.id);
    map.addLayer(line, firstSymbol.id);
  } else {
    map.addLayer(casing);
    map.addLayer(line);
  }

  const startElement = document.createElement("div");
  startElement.className = "route-map-marker start";
  startElement.textContent = "A";
  routeStartMarker = new maplibregl.Marker({ element: startElement })
    .setLngLat([origin.lon, origin.lat])
    .setPopup(new maplibregl.Popup({ offset: 12 }).setText("Salida: " + origin.name))
    .addTo(map);

  const endElement = document.createElement("div");
  endElement.className = "route-map-marker end";
  endElement.textContent = "B";
  routeEndMarker = new maplibregl.Marker({ element: endElement })
    .setLngLat([destination.lon, destination.lat])
    .setPopup(new maplibregl.Popup({ offset: 12 }).setText("Llegada: " + destination.name))
    .addTo(map);

  const bounds = new maplibregl.LngLatBounds();
  route.geometry.coordinates.forEach(coordinate => bounds.extend(coordinate));
  map.fitBounds(bounds, {
    padding: { top: 70, bottom: 75, left: 45, right: 45 },
    duration: 800,
    maxZoom: 11.5
  });
  routeIsVisible = true;
}

function renderRouteAnalysis(route, samples, results, origin, destination, directionLabel) {
  const totalRainNow = results.filter(item => item.currentRain).length;
  const totalWeakSignals = results.filter(item => item.currentWeakSignal).length;
  const totalRainEta = results.filter(item => item.etaRain).length;
  const pointsWithoutData = results.filter(item => !item.data).length;

  const sampleMarkup = results.map((item, index) => {
    let label = "Sin precipitación estimada";
    let className = "clear";
    if (!item.data) {
      label = "Sin datos";
      className = "unknown";
    } else if (item.currentRain) {
      label = "Precipitación estimada ahora";
      className = "rain";
    } else if (item.etaRain) {
      label = "Posible lluvia al llegar";
      className = "possible";
    } else if (item.currentWeakSignal) {
      label = "Señal débil del modelo";
      className = "possible";
    }

    const etaText = item.eta.toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" });
    const currentTimeText = item.currentTime ? formatLocalHour(item.currentTime) : "hora no disponible";
    const currentAmountText = item.currentPrecipitationMm === null
      ? "sin dato"
      : formatRouteMillimeters(item.currentPrecipitationMm) + " mm";
    const currentText = !item.data
      ? "Sin datos actuales"
      : item.currentRain
        ? currentAmountText + " · señal cuantitativa coherente del modelo"
        : item.currentWeakSignal
          ? currentAmountText + " · señal débil o no corroborada"
          : currentAmountText + " · sin precipitación cuantificable";
    const codeText = item.data
      ? item.currentCodeSuggestsRain && !item.currentRain
        ? "Código actual del modelo: " + item.currentWeatherDescription + " (no basta para confirmar precipitación)."
        : "Condición actual del modelo: " + item.currentWeatherDescription + "."
      : "";
    const forecastText = item.forecast
      ? Math.round(item.forecast.probability) + "% de probabilidad · " +
        formatRouteMillimeters(item.forecast.precipitation) + " mm previstos" +
        (isRainWeatherCode(item.forecast.weatherCode)
          ? " · código horario: " + weatherInfo(item.forecast.weatherCode).text
          : "")
      : "Pronóstico no disponible";

    return `
      <div class="route-sample">
        <div>
          <strong>Tramo ${index + 1} · ${escapeHtml(item.label)}</strong>
          <small>
            Km ${item.distanceAlongKm.toFixed(1)} desde la salida · Llegada estimada ${etaText}
            <br>Ahora (modelo, ${escapeHtml(currentTimeText)}): ${escapeHtml(currentText)}
            <br>${escapeHtml(codeText)}
            <br>A la llegada: ${escapeHtml(forecastText)}
          </small>
        </div>
        <span class="route-status-pill ${className}">${label}</span>
      </div>
    `;
  }).join("");

  let summary;
  if (pointsWithoutData === results.length) {
    summary = "No fue posible obtener datos meteorológicos de los puntos de esta ruta. No se puede concluir si lloverá.";
  } else {
    const summaryParts = [];
    if (totalRainNow > 0) {
      summaryParts.push(`El modelo muestra una señal cuantitativa coherente de precipitación actual (≥ 0,20 mm) en ${totalRainNow} de ${results.length} puntos. No es una observación directa de lluvia.`);
    } else {
      summaryParts.push("No hay una señal cuantitativa coherente suficiente para marcar precipitación actual en los puntos consultados.");
    }
    if (totalWeakSignals > 0) {
      summaryParts.push(`${totalWeakSignals} puntos presentan señales débiles o contradictorias del modelo; no se cuentan como lluvia actual.`);
    }
    if (totalRainEta > 0) {
      summaryParts.push(`Para la hora estimada de llegada, el pronóstico indica posibilidad de precipitación en ${totalRainEta} de ${results.length} puntos (probabilidad ≥ 50% o acumulación ≥ 0,10 mm).`);
    } else {
      summaryParts.push("El pronóstico no alcanza los umbrales definidos para señalar posibilidad de precipitación a la llegada.");
    }
    if (pointsWithoutData > 0) {
      summaryParts.push(`No hubo datos en ${pointsWithoutData} puntos; no se puede descartar lluvia localizada allí.`);
    }
    summary = summaryParts.join(" ");
  }

  $("routeResult").innerHTML = `
    <div class="route-result-head">
      <div class="route-result-title">Análisis · ${escapeHtml(directionLabel)}</div>
      <span class="tiny">${escapeHtml(origin.name)} → ${escapeHtml(destination.name)}</span>
    </div>
    <div class="route-result-metrics">
      <div class="route-result-metric"><strong>${(route.distance / 1000).toFixed(1)} km</strong><span>Distancia estimada</span></div>
      <div class="route-result-metric"><strong>${formatRouteDuration(route.duration)}</strong><span>Tiempo de conducción estimado</span></div>
    </div>
    <div class="route-result-summary">${escapeHtml(summary)}</div>
    <div class="route-samples">${sampleMarkup}</div>
    <p class="tiny" style="margin-top:10px">Fuente meteorológica: Open-Meteo. Se consultan ${results.length} puntos distribuidos a lo largo del recorrido. La etiqueta de precipitación actual requiere al menos 0,20 mm y coherencia entre variables del modelo; el código meteorológico por sí solo no activa lluvia. El pronóstico de llegada usa probabilidad ≥ 50% o acumulación ≥ 0,10 mm. Son estimaciones, no observaciones directas. El tiempo de viaje no incorpora tráfico en vivo.</p>
  `;
  $("routeResult").hidden = false;
}

async function analyzeRoute() {
  if (!mapReady) {
    $("routeResult").hidden = false;
    $("routeResult").textContent = "El mapa todavía se está cargando. Inténtalo en unos segundos.";
    return;
  }

  const button = $("routeAnalyzeBtn");
  button.disabled = true;
  button.textContent = "Analizando recorrido…";
  $("routeResult").hidden = false;
  $("routeResult").innerHTML = '<p class="tiny loading">Calculando carretera y consultando las condiciones meteorológicas de varios puntos del recorrido…</p>';

  try {
    let origin;
    let destination;
    let directionLabel;

    if (routeMode === "saved") {
      if (!routeWorkLocation) {
        throw new Error("Primero configura el destino del trabajo: búscalo o selecciónalo directamente en el mapa.");
      }
      const direction = $("routeDirection").value;
      if (direction === "outbound") {
        origin = ROUTE_HOME;
        destination = routeWorkLocation;
        directionLabel = "Ida · Casa → trabajo";
      } else {
        origin = routeWorkLocation;
        destination = ROUTE_HOME;
        directionLabel = "Regreso · Trabajo → casa";
      }
    } else {
      destination = routeTemporaryDestination;
      if (!destination) {
        throw new Error("Selecciona primero un destino temporal mediante el buscador o el mapa.");
      }
      origin = await getFreshGpsForRoute();
      directionLabel = "Ruta temporal";
    }

    const [west, south] = CR_NAVIGATION_BOUNDS[0];
    const [east, north] = CR_NAVIGATION_BOUNDS[1];
    [origin, destination].forEach(point => {
      if (point.lon < west || point.lon > east || point.lat < south || point.lat > north) {
        throw new Error("Uno de los puntos está fuera de los límites de Costa Rica.");
      }
    });

    $("routeResult").innerHTML = '<p class="tiny loading">Calculando ruta por carretera…</p>';
    const routeUrl = `${OSRM_ROUTE_URL}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&steps=false&alternatives=false`;
    const routeResponse = await fetchJson(routeUrl);
    if (routeResponse.code !== "Ok" || !routeResponse.routes || !routeResponse.routes.length) {
      throw new Error("No se encontró una ruta por carretera entre esos puntos.");
    }
    const route = routeResponse.routes[0];
    if (!route.geometry || !Array.isArray(route.geometry.coordinates) || route.geometry.coordinates.length < 2) {
      throw new Error("El servicio de rutas no devolvió una geometría válida.");
    }

    drawRouteOnMap(route, origin, destination);
    $("mapLocationChip").textContent = "🧭 " + directionLabel;

    const samples = sampleRouteLine(route.geometry.coordinates, route.distance / 1000);
    const departure = new Date();
    const weatherPromises = samples.map(async (sample, index) => {
      const eta = new Date(departure.getTime() + route.duration * sample.fraction * 1000);
      const point = {
        name: "Punto " + (index + 1),
        lat: sample.coordinate[1],
        lon: sample.coordinate[0]
      };
      try {
        const data = await getRouteWeather(point);
        const currentPrecipitationMm = getRouteCurrentPrecipitationMm(data.current);
        const currentRainComponentMm = getRouteCurrentRainComponentMm(data.current);
        const currentWeatherCode = Number(data.current?.weather_code);
        const currentCodeSuggestsRain = isRainWeatherCode(currentWeatherCode);
        // Para marcar precipitación actual se exige cantidad >= 0,20 mm y
        // coherencia con el campo rain/showers o con el código meteorológico.
        // El código WMO por sí solo nunca activa una alerta de lluvia actual.
        const currentRain = currentPrecipitationMm !== null &&
          currentPrecipitationMm >= 0.2 &&
          ((currentRainComponentMm !== null && currentRainComponentMm >= 0.1) || currentCodeSuggestsRain);
        const currentWeakSignal = !currentRain && (
          (currentPrecipitationMm !== null && currentPrecipitationMm >= 0.05) ||
          currentCodeSuggestsRain
        );
        const forecast = nearestHourlyForecast(data, eta);
        // El código horario es descriptivo, pero no basta por sí solo para
        // marcar lluvia futura: se exige probabilidad >= 50% o >= 0,10 mm.
        const etaRain = forecast
          ? forecast.probability >= 50 || forecast.precipitation >= 0.1
          : false;
        return {
          data,
          currentRain,
          currentWeakSignal,
          currentPrecipitationMm,
          currentRainComponentMm,
          currentWeatherCode,
          currentWeatherDescription: weatherInfo(currentWeatherCode).text,
          currentCodeSuggestsRain,
          currentTime: data.current?.time || null,
          etaRain,
          forecast,
          eta,
          distanceAlongKm: sample.distanceAlongKm,
          label: index === 0 ? "Salida" : index === samples.length - 1 ? "Llegada" : "Ruta intermedia"
        };
      } catch (error) {
        console.warn("No se pudo consultar el punto de ruta", index, error);
        return {
          data: null,
          currentRain: false,
          currentWeakSignal: false,
          currentPrecipitationMm: null,
          currentRainComponentMm: null,
          currentWeatherCode: null,
          currentWeatherDescription: "Sin datos",
          currentCodeSuggestsRain: false,
          currentTime: null,
          etaRain: false,
          forecast: null,
          eta,
          distanceAlongKm: sample.distanceAlongKm,
          label: index === 0 ? "Salida" : index === samples.length - 1 ? "Llegada" : "Ruta intermedia"
        };
      }
    });

    const results = await Promise.all(weatherPromises);
    renderRouteAnalysis(route, samples, results, origin, destination, directionLabel);
    $("mapStatusChip").textContent = "Ruta analizada · " + (route.distance / 1000).toFixed(1) + " km";
  } catch (error) {
    console.error("Error al analizar ruta:", error);
    $("routeResult").innerHTML = `<p class="tiny error-text">${escapeHtml(error.message || "No se pudo analizar el recorrido.")}</p>`;
    $("routeResult").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "🌧️ Analizar ruta";
  }
}

function closeRoutePanelOnly() {
  $("routePanel").hidden = true;
  $("routeToggle").setAttribute("aria-expanded", "false");
  $("routeToggle").textContent = "🧭 Rutas";
  cancelRouteMapPick();
}

// ------------------------------------------------------------
// PRONÓSTICO OPEN-METEO
// ------------------------------------------------------------
async function getWeatherData(location) {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "rain",
      "showers",
      "weather_code",
      "is_day",
      "wind_speed_10m"
    ].join(","),
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
      "weather_code",
      "is_day",
      "wind_speed_10m"
    ].join(","),
    daily: [
      "sunrise",
      "sunset",
      "daylight_duration",
      "precipitation_probability_max",
      "precipitation_sum",
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min"
    ].join(","),
    forecast_days: "2",
    timezone: "auto"
  });

  const data = await fetchJson(OPEN_METEO_FORECAST + "?" + params.toString());
  if (!data.current || !data.hourly || !data.daily) {
    throw new Error("La respuesta meteorológica está incompleta.");
  }
  return data;
}

function formatCurrentPrecipitationPeriod(intervalSeconds) {
  const seconds = Number(intervalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "el intervalo reciente";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes === 60) return "la última hora";
  if (minutes > 60 && minutes % 60 === 0) return `las últimas ${minutes / 60} horas`;
  return `los últimos ${minutes} min`;
}

function renderWeatherCard(containerId, location, data, isHome) {
  const container = $(containerId);
  const current = data.current;
  const info = weatherInfo(current.weather_code, current.is_day !== 0);
  const updated = formatLocalHour(current.time);
  const rainNow = Number(current.precipitation || 0);
  const rainPeriod = formatCurrentPrecipitationPeriod(current.interval);
  const details = location.detail || (isHome ? "Ubicación GPS actual" : "Costa Rica");

  container.innerHTML = `
    <div class="weather-card-head">
      <div>
        <div class="place-name">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div>
        <div class="place-subtitle">${escapeHtml(details)}</div>
      </div>
      <span class="tiny">Actualizado ${escapeHtml(updated)}</span>
    </div>
    <div class="current-main">
      <div class="weather-emoji">${info.icon}</div><div>
        <div class="current-temp">${Math.round(Number(current.temperature_2m))}°</div>
        <div class="current-desc">${escapeHtml(info.text)} · estimación del modelo</div>
        <div class="tiny">Sensación térmica ${Math.round(Number(current.apparent_temperature))} °C</div>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><strong>${formatMillimeters(rainNow)} mm</strong><span>Precipitación · ${escapeHtml(rainPeriod)}</span></div>
      <div class="metric"><strong>${Math.round(Number(current.relative_humidity_2m))}%</strong><span>Humedad</span></div>
      <div class="metric"><strong>${Math.round(Number(current.wind_speed_10m))} km/h</strong><span>Viento</span></div>
    </div>
    <div class="card-footer">
      <span class="tiny">${rainNow >= 0.1
        ? `El modelo estima ${formatMillimeters(rainNow)} mm durante ${rainPeriod}; no es una medición en tu ubicación exacta.`
        : `El modelo no estima precipitación medible durante ${rainPeriod}.`}</span>
      ${isHome ? "" : '<button class="btn secondary small-btn" id="returnHomeButton" type="button">Volver a mi zona</button>'}
    </div>
  `;

  if (!isHome) {
    const button = $("returnHomeButton");
    if (button) button.addEventListener("click", returnToHome);
  }
}

function getNext24Hours(data) {
  const hourly = data.hourly;
  const currentTime = data.current.time;
  let start = hourly.time.findIndex(time => time >= currentTime);
  if (start < 0) start = 0;

  const result = [];
  for (let i = start; i < Math.min(start + 24, hourly.time.length); i++) {
    result.push({
      time: hourly.time[i],
      probability: Number(hourly.precipitation_probability?.[i] ?? 0),
      precipitation: Number(hourly.precipitation?.[i] ?? 0),
      temperature: Number(hourly.temperature_2m?.[i] ?? 0),
      weatherCode: Number(hourly.weather_code?.[i] ?? 0),
      isDay: hourly.is_day?.[i] !== 0,
      wind: Number(hourly.wind_speed_10m?.[i] ?? 0)
    });
  }
  return result;
}

function buildRainWindows(hours) {
  const windows = [];
  let active = [];

  function closeWindow() {
    if (!active.length) return;
    windows.push(active);
    active = [];
  }

  hours.forEach(hour => {
    const signal = hour.probability >= 30 || hour.precipitation >= 0.1;
    if (signal) active.push(hour);
    else closeWindow();
  });
  closeWindow();
  return windows;
}

function renderForecast(location, data) {
  const hours = getNext24Hours(data);
  $("forecastTitle").textContent = "Pronóstico por hora · " + location.name;
  const summary = $("rainSummary");
  const windows = buildRainWindows(hours);

  if (!hours.length) {
    summary.innerHTML = '<div class="summary-title">Pronóstico no disponible</div><p class="summary-line muted">La fuente no devolvió horas de pronóstico.</p>';
    $("hourlyGrid").innerHTML = "";
    return;
  }

  if (!windows.length) {
    const maxProb = Math.max(...hours.map(hour => hour.probability));
    summary.innerHTML = `
      <div class="summary-title">Lluvia prevista en ${escapeHtml(location.name)}</div>
      <p class="summary-line">🌤️ No se observa una señal importante de precipitación en las próximas 24 horas.</p>
      <p class="tiny">La probabilidad máxima indicada por el modelo es ${maxProb}% . Esto no garantiza que no pueda presentarse lluvia localizada.</p>
    `;
  } else {
    const windowMarkup = windows.map(windowHours => {
      const first = windowHours[0];
      const last = windowHours[windowHours.length - 1];
      const maxProb = Math.max(...windowHours.map(hour => hour.probability));
      const totalMm = windowHours.reduce((sum, hour) => sum + hour.precipitation, 0);
      const timeRange = windowHours.length === 1
        ? formatLocalHour(first.time)
        : formatLocalHour(first.time) + " – " + formatLocalHour(last.time);
      return `<div class="rain-window"><strong>${escapeHtml(timeRange)}</strong><span>${maxProb}% de probabilidad máxima · ${formatMillimeters(totalMm)} mm estimados en el intervalo</span></div>`;
    }).join("");

    summary.innerHTML = `
      <div class="summary-title">Lluvia prevista en ${escapeHtml(location.name)}</div>
      <p class="summary-line">🌧️ Se estima posibilidad de precipitación en estos horarios:</p>
      ${windowMarkup}
    `;
  }

  $("hourlyGrid").innerHTML = hours.map(hour => {
    const info = weatherInfo(hour.weatherCode, hour.isDay !== false);
    return `
      <article class="hour-card">
        <div class="hour-time">${escapeHtml(formatLocalHour(hour.time))}</div>
        <div class="hour-icon">${info.icon}</div>
        <div class="hour-prob">${Math.round(hour.probability)}%</div>
        <div class="hour-detail">Prob. de precipitación<br>${formatMillimeters(hour.precipitation)} mm</div>
        <div class="hour-temp">${Math.round(hour.temperature)} °C</div>
      </article>
    `;
  }).join("");
}

function renderSolarCard(containerId, location, data, isHome) {
  const container = $(containerId);
  const daily = data.daily;
  const sunrise = daily.sunrise?.[0];
  const sunset = daily.sunset?.[0];
  const daylight = daily.daylight_duration?.[0];

  if (!sunrise || !sunset) {
    container.innerHTML = `<div class="solar-place">${escapeHtml(location.name)}</div><p class="subtitle">No se pudieron obtener los horarios solares.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="solar-place">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div>
    <p class="tiny">Horarios calculados para hoy en la zona horaria de la localidad.</p>
    <div class="solar-times">
      <div class="solar-time">
        <div class="symbol">🌄</div>
        <strong>${escapeHtml(formatLocalHour(sunrise))}</strong>
        <span>Amanecer</span>
      </div>
      <div class="solar-time">
        <div class="symbol">🌇</div>
        <strong>${escapeHtml(formatLocalHour(sunset))}</strong>
        <span>Atardecer</span>
      </div>
    </div>
    <div class="day-length">☀️ Duración del día: <strong>${escapeHtml(formatDayLength(daylight))}</strong></div>
  `;
}

async function loadWeatherForLocation(location, type) {
  const isHome = type === "home";
  const cardId = isHome ? "homeWeatherCard" : "destinationWeatherCard";
  const solarId = isHome ? "homeSolarCard" : "destinationSolarCard";
  if (!isHome) {
    $(cardId).hidden = false;
    $(solarId).hidden = false;
  }

  $(cardId).innerHTML = `<div class="place-name">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div><p class="subtitle loading">Consultando condiciones meteorológicas…</p>`;
  $(solarId).innerHTML = `<div class="solar-place">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div><p class="subtitle loading">Calculando amanecer y atardecer…</p>`;

  try {
    const data = await getWeatherData(location);
    if (isHome) {
      homeWeatherData = { location, data };
    } else {
      destinationWeatherData = { location, data };
    }

    renderWeatherCard(cardId, location, data, isHome);
    renderSolarCard(solarId, location, data, isHome);
    if (isHome && window.RainTrackAmbient) window.RainTrackAmbient.setWeather(data.current);

    if (isHome && !destinationLocation) renderForecast(location, data);
    if (!isHome) renderForecast(location, data);

    setSystemStatus("Datos meteorológicos actualizados", "ok");
  } catch (error) {
    console.error("Error meteorológico:", error);
    $(cardId).innerHTML = `<div class="place-name">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div><p class="subtitle error-text">No se pudieron consultar los datos meteorológicos. Inténtalo de nuevo.</p>`;
    $(solarId).innerHTML = `<div class="solar-place">${escapeHtml(isHome ? "Mi ubicación actual" : location.name)}</div><p class="subtitle error-text">No se pudieron calcular los horarios solares.</p>`;
    setSystemStatus("Error al consultar el pronóstico", "error");
  }
}

function returnToHome() {
  destinationLocation = null;
  destinationWeatherData = null;
  $("destinationWeatherCard").innerHTML = '<div class="place-name">Destino seleccionado</div><p class="subtitle">Busca una localidad para consultar si se estima lluvia en ese lugar.</p>';
  $("destinationSolarCard").innerHTML = '<div class="solar-place">Destino seleccionado</div><p class="subtitle">Busca una localidad para conocer su amanecer y atardecer.</p>';
  $("destinationWeatherCard").hidden = true;
  $("destinationSolarCard").hidden = true;

  if (homeLocation) {
    $("mapLocationChip").textContent = "📍 Mi ubicación actual";
    if (mapReady) {
      const [west, south] = CR_NAVIGATION_BOUNDS[0];
      const [east, north] = CR_NAVIGATION_BOUNDS[1];
      const gpsInsideCostaRica = homeLocation.lon >= west && homeLocation.lon <= east &&
        homeLocation.lat >= south && homeLocation.lat <= north;
      if (gpsInsideCostaRica) {
        map.flyTo({ center: [homeLocation.lon, homeLocation.lat], zoom: 12, speed: 1.1 });
      } else {
        showCostaRicaOverview(true);
      }
    }
    updateMapMarkers();
    if (homeWeatherData) renderForecast(homeWeatherData.location, homeWeatherData.data);
    else loadWeatherForLocation(homeLocation, "home");
  } else {
    requestCurrentLocation();
  }
}

// ------------------------------------------------------------
// UBICACIÓN GPS ACTUAL Y CACHÉ LOCAL
// Se reutiliza la última lectura durante 30 minutos.
// El botón "Actualizar mi ubicación" siempre solicita una lectura GPS nueva.
// ------------------------------------------------------------
let automaticLocationRefreshAttempted = false;

function formatLocationAge(savedAt) {
  const minutes = Math.max(0, Math.floor((Date.now() - savedAt) / 60000));
  if (minutes < 1) return "hace unos segundos";
  if (minutes === 1) return "hace 1 minuto";
  if (minutes < 60) return `hace ${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
}

function readSavedCurrentLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCATION_CACHE_KEY) || "null");
    if (!saved || !Number.isFinite(saved.lat) || !Number.isFinite(saved.lon) ||
        !Number.isFinite(saved.savedAt) ||
        saved.lat < -90 || saved.lat > 90 || saved.lon < -180 || saved.lon > 180) {
      return null;
    }
    if (Date.now() - saved.savedAt > LOCATION_CACHE_MAX_STALE_MS) {
      localStorage.removeItem(LOCATION_CACHE_KEY);
      return null;
    }
    return saved;
  } catch (error) {
    console.warn("No se pudo leer la ubicación guardada:", error);
    return null;
  }
}

function saveCurrentLocation(latitude, longitude, accuracy) {
  try {
    localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify({
      lat: latitude,
      lon: longitude,
      accuracy: accuracy || 0,
      savedAt: Date.now()
    }));
  } catch (error) {
    console.warn("No se pudo guardar la ubicación localmente:", error);
  }
}

function focusMapOnCurrentLocation() {
  if (!homeLocation || !mapReady) return;
  const [west, south] = CR_NAVIGATION_BOUNDS[0];
  const [east, north] = CR_NAVIGATION_BOUNDS[1];
  const insideCostaRica = homeLocation.lon >= west && homeLocation.lon <= east &&
    homeLocation.lat >= south && homeLocation.lat <= north;

  if (insideCostaRica) {
    const accuracy = Number(homeLocation.accuracy || 0);
    map.flyTo({
      center: [homeLocation.lon, homeLocation.lat],
      zoom: accuracy > 700 ? 10.5 : 12,
      speed: 1.1
    });
    $("mapLocationChip").textContent = "📍 Mi ubicación actual";
  } else {
    showCostaRicaOverview(true);
    $("mapLocationChip").textContent = "🇨🇷 Mapa enfocado en Costa Rica";
  }
  updateMapMarkers();
}

function restoreSavedCurrentLocation() {
  const saved = readSavedCurrentLocation();
  if (!saved) return null;

  const age = Date.now() - saved.savedAt;
  const fresh = age < LOCATION_CACHE_TTL_MS;
  homeLocation = {
    name: "Mi ubicación actual",
    lat: saved.lat,
    lon: saved.lon,
    accuracy: saved.accuracy || 0,
    detail: saved.accuracy
      ? `Ubicación guardada · precisión aproximada ±${Math.round(saved.accuracy)} m`
      : "Ubicación guardada en este dispositivo"
  };
  homeWeatherData = null;

  $("homeLocationDescription").textContent = fresh
    ? `Usando ubicación guardada ${formatLocationAge(saved.savedAt)}. Se actualizará automáticamente después de 30 minutos.`
    : `Última ubicación guardada ${formatLocationAge(saved.savedAt)}. Actualizando GPS…`;
  $("homeSetupNotice").hidden = true;
  $("mapLocationChip").textContent = fresh
    ? "📍 Mi ubicación · guardada"
    : "📍 Actualizando ubicación…";

  focusMapOnCurrentLocation();
  loadWeatherForLocation(homeLocation, "home");
  setSystemStatus(fresh ? "Usando ubicación guardada" : "Actualizando ubicación…", fresh ? "ok" : "loading");
  return { fresh, savedAt: saved.savedAt };
}

function showLocationError(error, keepExistingLocation = false) {
  console.warn("No se pudo obtener la ubicación GPS:", error);
  locationRequestInProgress = false;

  if (keepExistingLocation && homeLocation) {
    const saved = readSavedCurrentLocation();
    const ageText = saved ? formatLocationAge(saved.savedAt) : "anterior";
    $("homeLocationDescription").textContent =
      `No se pudo actualizar el GPS. Seguimos usando la última ubicación guardada (${ageText}).`;
    $("locationNoticeTitle").textContent = "No se pudo actualizar la ubicación";
    $("locationNoticeMessage").textContent =
      "RainTrack seguirá usando la última ubicación disponible. Puedes volver a intentarlo con «Actualizar mi ubicación».";
    $("homeSetupNotice").hidden = false;
    $("retryLocation").hidden = false;
    setSystemStatus("Usando ubicación guardada", "error");
    return;
  }

  homeLocation = null;
  homeWeatherData = null;
  updateMapMarkers();
  $("homeLocationDescription").textContent = "No se pudo detectar tu ubicación actual.";
  $("homeWeatherCard").innerHTML = '<div class="place-name">Mi ubicación actual</div><p class="subtitle error-text">No se pudo obtener la ubicación GPS. Inténtalo nuevamente.</p>';
  $("homeSolarCard").innerHTML = '<div class="solar-place">Mi ubicación actual</div><p class="subtitle error-text">Se necesita la ubicación GPS para calcular el amanecer y el atardecer.</p>';
  $("mapLocationChip").textContent = "🇨🇷 Costa Rica · Ubicación pendiente";
  $("forecastTitle").textContent = "Pronóstico por hora · Mi ubicación actual";
  $("rainSummary").innerHTML = '<div class="summary-title">Resumen de lluvia</div><p class="summary-line muted">Permite el acceso al GPS o busca un destino para consultar el pronóstico.</p>';
  $("hourlyGrid").innerHTML = "";

  let message = "No se pudo obtener tu ubicación. Comprueba que el GPS esté activado e inténtalo de nuevo.";
  if (error && error.code === 1) {
    message = "El permiso de ubicación está bloqueado. En Chrome, abre la configuración del sitio, permite Ubicación para RainTrack CR y vuelve a intentarlo.";
  } else if (error && error.code === 2) {
    message = "El teléfono no pudo determinar tu ubicación. Activa la ubicación del dispositivo y comprueba que tengas señal.";
  } else if (error && error.code === 3) {
    message = "La solicitud GPS tardó demasiado. Comprueba la señal y toca «Intentar nuevamente».";
  }

  $("locationNoticeTitle").textContent = "No se pudo detectar tu ubicación";
  $("locationNoticeMessage").textContent = message;
  $("homeSetupNotice").hidden = false;
  $("retryLocation").hidden = false;
  setSystemStatus("Ubicación pendiente", "error");
}

function requestCurrentLocation(preserveDestination = false, automatic = false) {
  if (locationRequestInProgress) return;
  locationRequestInProgress = true;
  const hadExistingLocation = !!homeLocation;

  if (!navigator.geolocation) {
    showLocationError({ code: 0, message: "Geolocalización no disponible" }, hadExistingLocation);
    $("locationNoticeMessage").textContent = "Este navegador no permite obtener GPS. Puedes buscar una localidad manualmente.";
    return;
  }

  $("homeSetupNotice").hidden = false;
  $("locationNoticeTitle").textContent = automatic
    ? "Actualizando tu ubicación automáticamente…"
    : "Detectando tu ubicación actual…";
  $("locationNoticeMessage").textContent = automatic
    ? "La ubicación guardada cumplió 30 minutos. RainTrack está solicitando una lectura GPS nueva."
    : "Solicitando una lectura GPS nueva. Esta acción reemplazará la ubicación guardada.";
  $("retryLocation").hidden = true;
  $("homeLocationDescription").textContent = "Solicitando ubicación GPS actual…";
  $("mapLocationChip").textContent = "📍 Detectando ubicación actual…";
  setSystemStatus("Solicitando ubicación GPS…", "loading");

  navigator.geolocation.getCurrentPosition(
    position => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const accuracy = Math.round(position.coords.accuracy || 0);

      saveCurrentLocation(latitude, longitude, accuracy);
      automaticLocationRefreshAttempted = false;
      homeLocation = {
        name: "Mi ubicación actual",
        lat: latitude,
        lon: longitude,
        accuracy,
        detail: accuracy
          ? `GPS actualizado · precisión aproximada ±${accuracy} m`
          : "Ubicación GPS actualizada"
      };
      locationRequestInProgress = false;
      homeWeatherData = null;

      if (!preserveDestination) {
        destinationLocation = null;
        destinationWeatherData = null;
        $("destinationWeatherCard").innerHTML = '<div class="place-name">Destino seleccionado</div><p class="subtitle">Busca una localidad para consultar si se estima lluvia en ese lugar.</p>';
        $("destinationSolarCard").innerHTML = '<div class="solar-place">Destino seleccionado</div><p class="subtitle">Busca una localidad para conocer su amanecer y atardecer.</p>';
  $("destinationWeatherCard").hidden = true;
  $("destinationSolarCard").hidden = true;
      }

      $("homeLocationDescription").textContent = accuracy
        ? `Ubicación actualizada · precisión aproximada ±${accuracy} m. Se guardará durante 30 minutos en este dispositivo.`
        : "Ubicación actualizada y guardada durante 30 minutos en este dispositivo.";
      $("locationNoticeTitle").textContent = "Ubicación actualizada correctamente";
      $("locationNoticeMessage").textContent = "El mapa y los datos meteorológicos se están actualizando para el lugar donde estás.";
      $("homeSetupNotice").hidden = true;
      $("mapLocationChip").textContent = "📍 Mi ubicación actual";

      focusMapOnCurrentLocation();
      loadWeatherForLocation(homeLocation, "home");
      setSystemStatus("Ubicación actualizada", "ok");
    },
    error => showLocationError(error, hadExistingLocation),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

function refreshLocationIfExpired() {
  if (locationRequestInProgress || automaticLocationRefreshAttempted) return;
  const saved = readSavedCurrentLocation();
  if (saved && Date.now() - saved.savedAt >= LOCATION_CACHE_TTL_MS) {
    automaticLocationRefreshAttempted = true;
    requestCurrentLocation(true, true);
  }
}

$("retryLocation").addEventListener("click", () => requestCurrentLocation(true, false));
$("refreshCurrentLocation").addEventListener("click", () => requestCurrentLocation(true, false));
$("goHomeMap").addEventListener("click", returnToHome);

// Al volver a la pestaña solo se comprueba si vencieron los 30 minutos.
// No se consulta el GPS en cada cambio de pestaña.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLocationIfExpired();
});
setInterval(refreshLocationIfExpired, 60 * 1000);

// ------------------------------------------------------------
// CAPAS INTEGRADAS EN EL MISMO MAPA
// ------------------------------------------------------------
function closeLayersPanel() {
  $('layersPanel').hidden = true;
  $('layersToggle').setAttribute('aria-expanded', 'false');
  $('layersToggle').textContent = '☷ Capas del mapa ▼';
}

$('layersToggle').addEventListener('click', () => {
  const panel = $('layersPanel');
  panel.hidden = !panel.hidden;
  $('layersToggle').setAttribute('aria-expanded', String(!panel.hidden));
  $('layersToggle').textContent = panel.hidden ? '☷ Capas del mapa ▼' : '☷ Capas del mapa ▲';
});
$('layersClose').addEventListener('click', closeLayersPanel);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('layersPanel').hidden) closeLayersPanel();
    else if (document.body.classList.contains('map-focus')) setMapFocusMode(false);
  }
});

$('imnMapToggle').addEventListener('change', event => {
  setImnVisibility(event.target.checked);
});
$('imnProduct').addEventListener('change', () => {
  if ($('imnMapToggle').checked) refreshImnImage();
});
$('imnRefresh').addEventListener('click', () => {
  if (!$('imnMapToggle').checked) $('imnMapToggle').checked = true;
  setImnVisibility(true);
});
$('imnCardClose').addEventListener('click', () => {
  $('imnMapToggle').checked = false;
  setImnVisibility(false);
});
$('camerasToggle').addEventListener('change', addCameraMarkers);
$('stationsToggle').addEventListener('change', addCameraMarkers);
$('tempToggle').addEventListener('change', () => {
  dismissedCameraAlertIds.delete("temp:high");
  dismissedCameraAlertIds.delete("temp:low");
  renderCameraAlerts();
  addCameraMarkers();
});

// ------------------------------------------------------------
// EVENTOS DEL PLANIFICADOR DE RUTAS
// ------------------------------------------------------------
updateSavedWorkStatus();

$("routeToggle").addEventListener("click", () => {
  const panel = $("routePanel");
  panel.hidden = !panel.hidden;
  $("routeToggle").setAttribute("aria-expanded", String(!panel.hidden));
  $("routeToggle").textContent = panel.hidden ? "🧭 Rutas" : "🧭 Rutas ▲";
  if (!panel.hidden) updateSavedWorkStatus();
});

$("routePanelClose").addEventListener("click", closeRoutePanelOnly);
$("routeSavedMode").addEventListener("click", () => setRouteMode("saved"));
$("routeTempMode").addEventListener("click", () => setRouteMode("temporary"));

$("routeWorkSearchBtn").addEventListener("click", () => {
  searchRoutePlaces($("routeWorkSearchInput").value, "routeWorkSearchResults", "work");
});
$("routeWorkSearchInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchRoutePlaces($("routeWorkSearchInput").value, "routeWorkSearchResults", "work");
  }
});

$("routeTempSearchBtn").addEventListener("click", () => {
  searchRoutePlaces($("routeTempSearchInput").value, "routeTempSearchResults", "temporary");
});
$("routeTempSearchInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchRoutePlaces($("routeTempSearchInput").value, "routeTempSearchResults", "temporary");
  }
});

$("routePickWorkBtn").addEventListener("click", () => beginRouteMapPick("work"));
$("routePickTempBtn").addEventListener("click", () => beginRouteMapPick("temporary"));
$("routePickCancel").addEventListener("click", cancelRouteMapPick);
$("routeAnalyzeBtn").addEventListener("click", analyzeRoute);
$("routeClearBtn").addEventListener("click", closeRouteAnalysis);

// ------------------------------------------------------------
// CONTROLES DESPLEGABLES Y ACTUALIZACIÓN AUTOMÁTICA
// ------------------------------------------------------------
// Secciones plegables: empiezan ocultas y se recuerda la última elección en este dispositivo.
function setupCollapsible(buttonId, panelId, storageKey) {
  const button = $(buttonId);
  const panel = $(panelId);
  const apply = open => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Ocultar ▲" : "Mostrar ▼";
  };
  let saved = false;
  try { saved = localStorage.getItem(storageKey) === "open"; } catch (error) { /* sin almacenamiento */ }
  apply(saved);
  button.addEventListener("click", () => {
    const open = panel.hidden;
    apply(open);
    try { localStorage.setItem(storageKey, open ? "open" : "closed"); } catch (error) { /* sin almacenamiento */ }
  });
}
setupCollapsible("searchToggle", "searchPanel", "raintrackcr_section_search_v1");
setupCollapsible("conditionsToggle", "conditionsPanel", "raintrackcr_section_conditions_v1");
setupCollapsible("forecastToggle", "forecastPanel", "raintrackcr_section_forecast_v1");
setupCollapsible("solarToggle", "solarPanel", "raintrackcr_section_solar_v1");

$("radarSource").value = ownRainSelected ? "raintrack" : (RADAR_SOURCES[radarSourceKey] ? radarSourceKey : "librewxr");
$("librewxrColorScheme").value = String(librewxrColorScheme);
$("radarSource").addEventListener("change", loadRadarSource);
$("mapShell").classList.toggle("map-dark", basemapMode === "dark");
syncBasemapButton();
$("basemapQuick").addEventListener("click", () => applyBasemap(basemapMode === "dark" ? "light" : "dark"));
$("librewxrColorScheme").addEventListener("change", event => {
  const nextColor = Number(event.target.value);
  librewxrColorScheme = LIBREWXR_PALETTES.includes(nextColor) ? nextColor : 10;
  localStorage.setItem(LIBREWXR_COLOR_STORAGE_KEY, String(librewxrColorScheme));
  loadRadarSource();
});
$("radarSourceRefresh").addEventListener("click", loadRadarSource);
$("frameSlider").addEventListener("input", event => showRadarFrame(Number(event.target.value)));
$("playRadar").addEventListener("click", toggleRadarAnimation);

function setMapFocusMode(enabled) {
  document.body.classList.toggle("map-focus", enabled);
  document.documentElement.style.overflow = enabled ? "hidden" : "";
  $("mapExpandToggle").setAttribute("aria-pressed", String(enabled));
  $("mapExpandToggle").textContent = enabled ? "↙ Salir del mapa" : "⛶ Ampliar mapa";
  $("mapExpandToggle").setAttribute("aria-label", enabled ? "Salir de la pantalla completa del mapa" : "Ampliar mapa a pantalla completa");
  if (enabled) closeLayersPanel();
  requestAnimationFrame(() => {
    if (map) map.resize();
    requestAnimationFrame(() => { if (map) map.resize(); });
  });
}

$("mapExpandToggle").addEventListener("click", () => {
  setMapFocusMode(!document.body.classList.contains("map-focus"));
});
window.addEventListener("resize", () => {
  if (map && document.body.classList.contains("map-focus")) map.resize();
});

function refreshWeatherData() {
  if (homeLocation) loadWeatherForLocation(homeLocation, "home");
  if (destinationLocation) loadWeatherForLocation(destinationLocation, "destination");
}

function startAutomaticUpdates() {
  if (weatherRefreshTimer) clearInterval(weatherRefreshTimer);
  weatherRefreshTimer = setInterval(refreshWeatherData, 30 * 60 * 1000);
  loadCameraMonitoringData();
  if (cameraMonitorTimer) clearInterval(cameraMonitorTimer);
  cameraMonitorTimer = setInterval(loadCameraMonitoringData, 2 * 60 * 1000);
  // Solo LibreWXR se actualiza automáticamente; los proveedores con KEY
  // quedan bajo actualización manual para no consumir cuota por mosaicos.
  setInterval(() => {
    if (mapReady && radarSourceKey === "librewxr") loadRadarSource();
  }, 5 * 60 * 1000);
  if (imnRefreshTimer) clearInterval(imnRefreshTimer);
  imnRefreshTimer = setInterval(() => {
    if ($('imnMapToggle') && $('imnMapToggle').checked) refreshImnImage();
  }, 10 * 60 * 1000);
}

// ------------------------------------------------------------
// INICIO
// ------------------------------------------------------------
if ($("radarSource")) $("radarSource").value = ownRainSelected ? "raintrack" : radarSourceKey;
initMap();
const restoredLocation = restoreSavedCurrentLocation();
if (!restoredLocation) {
  automaticLocationRefreshAttempted = true;
  requestCurrentLocation();
} else if (!restoredLocation.fresh) {
  automaticLocationRefreshAttempted = true;
  requestCurrentLocation(true, true);
}
startAutomaticUpdates();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(error => console.warn("Service worker no disponible:", error));
  });
}
