import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { requestSafetyRoad, type ApiMetric, type ReportResponse, type TrackingResponse, type TrackingMovement } from "./safetyroad-api";

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento disponible */
  }
};
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = "&copy; OpenStreetMap contributors";
// Estado de cámara del mapa principal: sobrevive a los cambios de pantalla
let savedView: { center: L.LatLngTuple; zoom: number } | null = null;
let lastUserLocation: L.LatLngTuple | null = null;
let didInitialFly = false;
let userMovedMap = false;
const DEFAULT_CENTER: L.LatLngTuple = [-29.9533, -71.3395];

const ROAD_TYPES =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian";

async function getJson<T>(url: string, ms = 9000): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

const shortName = (n: string) =>
  n.replace(/^Avenida /i, "Av. ").replace(/^Calle /i, "").replace(/^Pasaje /i, "Pje. ");

// Convierte coordenadas en "Calle A con Calle B" (o calle + número) usando datos de OpenStreetMap
async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const dist = (p: { lat: number; lon: number }) =>
    Math.hypot((p.lon - lng) * kx, (p.lat - lat) * 110540);

  const roads = (async () => {
    const q = `[out:json][timeout:8];way(around:40,${lat},${lng})["highway"~"^(${ROAD_TYPES})$"]["name"];out geom;`;
    const data = await getJson<{
      elements?: Array<{ tags?: { name?: string }; geometry?: Array<{ lat: number; lon: number }> }>;
    }>(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    const best = new Map<string, number>();
    for (const el of data.elements ?? []) {
      const name = el.tags?.name;
      if (!name || !el.geometry?.length) continue;
      const d = Math.min(...el.geometry.map(dist));
      if (d < (best.get(name) ?? Infinity)) best.set(name, d);
    }
    return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => shortName(n));
  })();

  const place = getJson<{
    address?: Record<string, string>;
    display_name?: string;
  }>(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=es&lat=${lat}&lon=${lng}`,
  );

  const [r, p] = await Promise.allSettled([roads, place]);
  const names = r.status === "fulfilled" ? r.value : [];
  if (names.length >= 2) return `${names[0]} con ${names[1]}`;

  const a = p.status === "fulfilled" ? p.value.address : undefined;
  const area = a?.suburb || a?.neighbourhood || a?.city_district || a?.city || a?.town || a?.village;
  const road = names[0] || (a?.road ? shortName(a.road) : "");
  if (road) {
    const num = a?.house_number ? ` ${a.house_number}` : "";
    return `${road}${num}${area ? `, ${area}` : ""}`;
  }
  if (p.status === "fulfilled" && p.value.display_name) {
    return p.value.display_name.split(",").slice(0, 3).join(",").trim();
  }
  return null;
}

const SENSITIVITY_MS2: Record<string, number> = { Alta: 20, Media: 30, Baja: 40 };

type Severity = "LEVE" | "MODERADA" | "GRAVE" | "INDETERMINADA";
type IncidentStatus =
  | "DETECTADO"
  | "EN_VERIFICACION"
  | "ALERTA_OPERADOR"
  | "EN_REVISION"
  | "DERIVADO"
  | "CERRADO_ATENDIDO"
  | "CERRADO_FALSA_ALARMA";
type Origin = "CAMARA" | "APP_CIUDADANO" | "APP_IMPACTO";
type Screen = "map" | "detail" | "report" | "alerts" | "zone" | "metrics" | "settings";

type Incident = {
  id: string;
  place: string;
  severity: Severity;
  status: IncidentStatus;
  time: string;
  date: string;
  camera: string;
  origin: Origin;
  vehicles: number;
  heavy: boolean;
  blockage: string;
  lat: number;
  lng: number;
  pin: { left: string; top: string };
  trackingToken?: string;
  archivado?: boolean;
  token?: string; // Compatibilidad con reportes guardados por la demo web anterior.
  prioridadSugerida?: string;
  serviciosDerivados?: string[];
  movimientos?: TrackingMovement[];
  tipoReportado?: string;
  ninosReportados?: string;
  rolReportante?: string;
  createdAt?: string;
};

type AlertRecord = {
  id: number;
  title: string;
  status: IncidentStatus;
  date: string;
  reason: string;
  trackingToken?: string;
  incidentId?: string;
  archivado?: boolean;
  serviciosDerivados?: string[];
  movimientos?: TrackingMovement[];
};

const INITIAL_INCIDENTS: Incident[] = [];


// Solo mostrar en el mapa incidencias recientes y activas. Los expedientes
// permanecen guardados en el historial, aunque su pin caduque.
const MAP_VISIBLE_HOURS = 24;
function isVisibleOnMap(item: Incident): boolean {
  if (item.status.startsWith("CERRADO")) return false;
  if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return false;
  // Los ejemplos iniciales del diseño no representan hechos recientes.
  if (item.id.startsWith("INC-2025-")) return false;
  const ms = Date.parse(item.createdAt || item.date || "");
  return Number.isFinite(ms) && Date.now() - ms >= 0 &&
    Date.now() - ms < MAP_VISIBLE_HOURS * 60 * 60 * 1000;
}

const LIFECYCLE: IncidentStatus[] = [
  "DETECTADO",
  "EN_VERIFICACION",
  "ALERTA_OPERADOR",
  "EN_REVISION",
  "DERIVADO",
  "CERRADO_ATENDIDO",
];

const Icon = ({ name, size = 20 }: { name: string; size?: number }) => {
  const paths: Record<string, React.ReactNode> = {
    menu: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
      </>
    ),
    alert: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    pin: (
      <>
        <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    warning: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5M12 17.5v.5" />
      </>
    ),
    chart: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </>
    ),
    bolt: <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    back: <path d="m15 18-6-6 6-6" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    phone: (
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
    ),
    check: <path d="m5 12 4 4L19 6" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
};

function Chip({ children, tone = "gray" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`chip chip-${tone.toLowerCase()}`}>{children}</span>;
}

function Header({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
}) {
  return (
    <header className="sub-header">
      <button className="icon-btn" onClick={onBack} aria-label="Volver">
        <Icon name="back" />
      </button>
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </header>
  );
}

function MapArtwork({
  incidents,
  radius,
  onIncident,
  main = false,
}: {
  incidents: Incident[];
  radius: number;
  onIncident: (i: Incident) => void;
  main?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const incidentLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const zoneCircleRef = useRef<L.Circle | null>(null);
  const onIncidentRef = useRef(onIncident);
  const [userLocation, setUserLocation] = useState<L.LatLngExpression>(lastUserLocation ?? DEFAULT_CENTER);
  const [locationState, setLocationState] = useState<"buscando" | "gps" | "referencia">("buscando");
  const [mapProviderReady, setMapProviderReady] = useState(true);

  onIncidentRef.current = onIncident;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const start = lastUserLocation ?? DEFAULT_CENTER;
    const map = L.map(containerRef.current, {
      center: main && savedView ? savedView.center : start,
      zoom: main ? (savedView?.zoom ?? 12) : 13,
      zoomControl: false,
      attributionControl: true,
    });
    const mapTilerKey = import.meta.env.VITE_MAPTILER_API_KEY;
    if (mapTilerKey) {
      L.tileLayer(
        `https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=${encodeURIComponent(mapTilerKey)}`,
        {
          attribution:
            '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OpenStreetMap contributors',
          maxZoom: 20,
          crossOrigin: true,
        },
      ).addTo(map);
    } else {
      L.tileLayer(OSM_URL, { attribution: OSM_ATTR, maxZoom: 19, className: "osm-dark" }).addTo(map);
    }
    L.control.zoom({ position: "bottomright" }).addTo(map);

    const userIcon = L.divIcon({
      className: "live-user-marker",
      html: '<span class="live-user-pulse"></span><span class="live-user-core"></span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    userMarkerRef.current = L.marker(start, {
      icon: userIcon,
      zIndexOffset: 500,
    })
      .bindTooltip("Tú", {
        permanent: true,
        direction: "bottom",
        offset: [0, 11],
        className: "user-tooltip",
      })
      .addTo(map);
    zoneCircleRef.current = L.circle(start, {
      radius: radius * 1000,
      color: "#f2f2f2",
      weight: 1.5,
      opacity: 0.75,
      fillColor: "#dbeafe",
      fillOpacity: 0.12,
      interactive: false,
    })
      .bindTooltip("Tu Zona", { permanent: true, direction: "top", className: "zone-tooltip" })
      .addTo(map);
    incidentLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    if (main) {
      map.on("dragstart", () => {
        userMovedMap = true;
      });
      map.on("moveend", () => {
        const c = map.getCenter();
        savedView = { center: [c.lat, c.lng], zoom: map.getZoom() };
      });
    }

    window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      incidentLayerRef.current = null;
      userMarkerRef.current = null;
      zoneCircleRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationState("referencia");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const location: L.LatLngExpression = [coords.latitude, coords.longitude];
        lastUserLocation = [coords.latitude, coords.longitude];
        setUserLocation(location);
        setLocationState("gps");
        userMarkerRef.current?.setLatLng(location);
        zoneCircleRef.current?.setLatLng(location);
        if (main) {
          // Auto-zoom solo en la primera carga de la app
          if (!didInitialFly && !userMovedMap) mapRef.current?.flyTo(location, 14, { duration: 1.2 });
          didInitialFly = true;
        } else if (!mapRef.current?.getCenter().equals(location as L.LatLngTuple, 0.001)) {
          mapRef.current?.setView(location, 13, { animate: false });
        }
      },
      () => setLocationState("referencia"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    zoneCircleRef.current?.setRadius(radius * 1000);
  }, [radius]);

  useEffect(() => {
    const layer = incidentLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    incidents.filter(isVisibleOnMap).forEach((incident) => {
      if (!Number.isFinite(incident.lat) || !Number.isFinite(incident.lng)) return;
      const color =
        incident.severity === "GRAVE"
          ? "#e53935"
          : incident.severity === "MODERADA"
            ? "#f59e0b"
            : incident.severity === "LEVE" ? "#22c55e" : "#94a3b8";
      const icon = L.divIcon({
        className: "live-incident-marker",
        html: `<span style="--pin-color:${color}"><b>!</b></span>`,
        iconSize: [38, 44],
        iconAnchor: [19, 42],
      });
      L.marker([incident.lat, incident.lng], {
        icon,
        title: `Prioridad ${incident.severity} (no confirmada): ${incident.place}`,
      })
        .on("click", () => onIncidentRef.current(incident))
        .addTo(layer);
    });
  }, [incidents]);

  const recenter = () => mapRef.current?.flyTo(userLocation, 15, { duration: 0.8 });

  return (
    <div className="map-art">
      <div ref={containerRef} className="live-map" aria-label="Mapa real de La Serena y Coquimbo" />
      {!mapProviderReady && (
        <div className="map-provider-error">
          <strong>Mapa temporalmente no disponible</strong>
          <span>Revisa la configuración de MapTiler.</span>
        </div>
      )}
      <div className={`map-live-badge ${locationState}`}>
        <i />
        {locationState === "gps"
          ? "GPS en vivo"
          : locationState === "buscando"
            ? "Buscando GPS…"
            : "Ubicación de referencia"}
      </div>
      {locationState === "referencia" && (
        <div className="location-warning">
          <Icon name="warning" size={14} />
          <span>No se detectó tu ubicación. Activa el GPS para centrar el mapa.</span>
        </div>
      )}
      <button
        className="locate-button"
        onClick={recenter}
        aria-label="Centrar mapa en mi ubicación"
      >
        <Icon name="pin" size={18} />
      </button>
    </div>
  );
}

function IncidentCard({ incident, onClick }: { incident: Incident; onClick: () => void }) {
  return (
    <button className="incident-card" onClick={onClick}>
      <div className="incident-card-top">
        <strong>{incident.place}</strong>
        <Icon name="chevron" size={17} />
      </div>
      <div className="chips">
        <Chip tone={incident.severity}>{incident.severity}</Chip>
        <Chip>{incident.status}</Chip>
      </div>
      <p>
        {incident.time} <span>·</span> {incident.camera}
      </p>
    </button>
  );
}

function BottomSheet({
  incidents,
  onIncident,
}: {
  incidents: Incident[];
  onIncident: (i: Incident) => void;
}) {
  const positions = [116, 390, Math.round(Math.min(window.innerHeight, 932) * 0.86)];
  const [height, setHeight] = useState(positions[0]);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ y: 0, height: 0 });

  const snap = (value: number) => {
    const nearest = positions.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
    setHeight(nearest);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, height };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setHeight(
      Math.max(
        positions[0],
        Math.min(positions[2], drag.current.height + drag.current.y - e.clientY),
      ),
    );
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    snap(height);
  };
  const cycle = () => {
    const current = positions.findIndex((p) => Math.abs(p - height) < 8);
    setHeight(positions[(current + 1) % positions.length]);
  };

  return (
    <section className={`bottom-sheet ${dragging ? "dragging" : ""}`} style={{ height }}>
      <div
        className="sheet-drag-area"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button className="handle" onClick={cycle} aria-label="Cambiar altura de la hoja" />
        <div className="sheet-title">
          <h2>Incidentes de prueba y reportes de este dispositivo</h2>
          <span>{incidents.filter(isVisibleOnMap).length} activos (24 h)</span>
        </div>
      </div>
      <div className="incident-list">
        {incidents.filter(isVisibleOnMap).map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            onClick={() => onIncident(incident)}
          />
        ))}
      </div>
    </section>
  );
}

function ImpactModal({ onResolve }: { onResolve: (needHelp: boolean) => void }) {
  const [seconds, setSeconds] = useState(15);
  const resolved = useRef(false);
  const resolve = (help: boolean) => {
    if (resolved.current) return;
    resolved.current = true;
    onResolve(help);
  };
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setSeconds((s) => {
          if (s <= 1) {
            window.clearInterval(timer);
            window.setTimeout(() => resolve(true), 0);
            return 0;
          }
          return s - 1;
        }),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const circumference = 2 * Math.PI * 52;
  return (
    <div
      className="modal-overlay impact-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="impact-title"
    >
      <div className="impact-card">
        <div className="impact-band">
          <Icon name="warning" size={18} /> MOVIMIENTO BRUSCO REGISTRADO
        </div>
        <div className="impact-body">
          <h2 id="impact-title">¿Estás bien?</h2>
          <Chip>EN_VERIFICACION</Chip>
          <div className="countdown">
            <svg viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" className="countdown-track" />
              <circle
                cx="60"
                cy="60"
                r="52"
                className="countdown-value"
                style={{
                  strokeDasharray: circumference,
                  strokeDashoffset: circumference * (1 - seconds / 15),
                }}
              />
            </svg>
            <strong>{seconds}</strong>
          </div>
          <p className="assist-copy">Puedes solicitar atención sin completar formularios.</p>
          <button className="btn btn-green" onClick={() => resolve(false)}>
            <Icon name="check" /> SÍ, ESTOY BIEN <span>(Cancelar)</span>
          </button>
          <button className="btn btn-red" onClick={() => resolve(true)}>
            <Icon name="phone" /> NECESITO AYUDA
          </button>
          <p className="impact-foot">
            Se registrará el aviso en <strong>{seconds}s</strong> si no cancelas.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConsentModal({ onChoice }: { onChoice: (accepted: boolean) => void }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="consent-card">
        <div className="consent-icon">
          <Icon name="shield" size={28} />
        </div>
        <p className="eyebrow">TU PRIVACIDAD IMPORTA</p>
        <h2 id="consent-title">Consentimiento informado</h2>
        <p className="consent-intro">
          Antes de activar SafetyRoad, queremos contarte cómo protegemos tus datos.
        </p>
        <ul className="consent-list">
          <li>
            <span>01</span>
            <p>
              Usamos el <strong>acelerómetro y GPS</strong> solo para detectar un impacto brusco.
            </p>
          </li>
          <li>
            <span>02</span>
            <p>Tu ubicación se envía únicamente si hay impacto y no cancelas la alerta.</p>
          </li>
          <li>
            <span>03</span>
            <p>No usamos reconocimiento facial ni leemos patentes. Toda evidencia se anonimiza.</p>
          </li>
          <li>
            <span>04</span>
            <p>Puedes revocar este consentimiento en Configuración.</p>
          </li>
        </ul>
        <button className="btn btn-red" onClick={() => onChoice(true)}>
          Acepto (Opt-In)
        </button>
        <button className="btn btn-ghost" onClick={() => onChoice(false)}>
          No acepto
        </button>
      </div>
    </div>
  );
}

function DetailScreen({
  incident,
  onBack,
  onUpdate,
}: {
  incident: Incident;
  onBack: () => void;
  onUpdate: (status: IncidentStatus) => void;
}) {
  const currentIndex = LIFECYCLE.indexOf(incident.status);

  const next =
    currentIndex >= 0 && currentIndex < LIFECYCLE.length - 1 ? LIFECYCLE[currentIndex + 1] : null;
  const json = {
    id_incidente: incident.id,
    timestamp_deteccion: incident.date,
    ubicacion: {
      latitud: incident.lat,
      longitud: incident.lng,
      interseccion_referencia: incident.place,
      id_camara_origen: incident.camera,
    },
    caracterizacion: {
      gravedad_estimada: incident.severity,
      cantidad_vehiculos_estimada: incident.vehicles,
      presencia_vehiculos_pesados: incident.heavy,
      bloqueo_calzada: incident.blockage,
    },
    evidencia: { disponible: false, nota: "No hay evidencia de cámara en el reporte de la app" },
    estado_gestion: incident.status,
  };
  const rows = [
    ["Fecha y hora", incident.date],
    ["Cámara / origen", incident.camera],
    ["Vehículos", String(incident.vehicles)],
    ["Pesados", incident.heavy ? "Sí" : "No"],
    ["Bloqueo", incident.blockage],
    ["Evidencia", "No disponible en reporte ciudadano"],
    ["Estado del despacho externo", "No conectado"],
  ];
  return (
    <div className="screen scroll-screen">
      <Header title="Ficha del incidente" subtitle={incident.id} onBack={onBack} />
      <main className="screen-content detail-content">
        <div className="detail-title">
          <p className="eyebrow">UBICACIÓN</p>
          <h2>{incident.place}</h2>
          <div className="chips">
            <Chip tone={incident.severity}>{incident.severity}</Chip>
            <Chip>{incident.origin}</Chip>
          </div>
          {incident.trackingToken && <p>Reporte registrado. Sugerencia interna para revisión: {incident.prioridadSugerida || "sin clasificación"}. No confirma un accidente.</p>}
        </div>
        <section className="info-table">
          {rows.map(([key, value]) => (
            <div className="info-row" key={key}>
              <span>{key}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
        <section className="detail-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">SEGUIMIENTO</p>
              <h3>Ciclo de vida</h3>
            </div>
            <Chip tone="green">EN CURSO</Chip>
          </div>
          <div className="timeline">
            {LIFECYCLE.map((state, index) => {
              const reached = currentIndex >= index || incident.status === "CERRADO_FALSA_ALARMA";
              const current = incident.status === state;
              return (
                <div
                  className={`timeline-item ${reached ? "reached" : ""} ${current ? "current" : ""}`}
                  key={state}
                >
                  <i />
                  <div>
                    <strong>{state}</strong>
                    <span>{current ? "Estado actual" : reached ? "Completado" : "Pendiente"}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {incident.trackingToken && <p>El estado se actualiza desde el panel del operador.</p>}
          {next && !incident.trackingToken && (
            <button className="btn btn-red action-btn" onClick={() => onUpdate(next)}>
              Avanzar a {next}
              <small>Ejemplo local, sin servidor</small>
            </button>
          )}
          {incident.status === "EN_REVISION" && !incident.trackingToken && (
            <button className="btn btn-ghost" onClick={() => onUpdate("CERRADO_FALSA_ALARMA")}>
              Descartar (falsa alarma)
            </button>
          )}
        </section>
        {incident.trackingToken && <DetalleDerivacion servicios={incident.serviciosDerivados} movimientos={incident.movimientos} />}
        <section className="detail-section json-section">
          <p className="eyebrow">DATOS TÉCNICOS</p>
          <h3>Registro (JSON)</h3>
          <pre>{JSON.stringify(json, null, 2)}</pre>
        </section>
      </main>
    </div>
  );
}

type SelectedLocation = {
  lat: number;
  lng: number;
  label: string;
};

function LocationPicker({ onSelect }: { onSelect: (location: SelectedLocation) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onSelectRef = useRef(onSelect);
  const requestRef = useRef(0);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [gpsUnavailable, setGpsUnavailable] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsUnavailable(true);
      setCenter([-29.9533, -71.3395]);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => setCenter([coords.latitude, coords.longitude]),
      () => {
        setGpsUnavailable(true);
        setCenter([-29.9533, -71.3395]);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 },
    );
  }, []);

  useEffect(() => {
    if (!center || !containerRef.current || mapRef.current) return;
    const mapTilerKey = import.meta.env.VITE_MAPTILER_API_KEY;
    const map = L.map(containerRef.current, {
      center,
      zoom: 16,
      zoomControl: true,
      attributionControl: true,
    });
    if (mapTilerKey) {
      L.tileLayer(
        `https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=${encodeURIComponent(mapTilerKey)}`,
        {
          attribution:
            '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OpenStreetMap contributors',
          maxZoom: 20,
          crossOrigin: true,
        },
      ).addTo(map);
    } else {
      L.tileLayer(OSM_URL, { attribution: OSM_ATTR, maxZoom: 19, className: "osm-dark" }).addTo(map);
    }

    const pickerIcon = L.divIcon({
      className: "picker-map-marker",
      html: "<span></span>",
      iconSize: [38, 44],
      iconAnchor: [19, 42],
    });

    map.on("click", async ({ latlng }: L.LeafletMouseEvent) => {
      if (!markerRef.current) {
        markerRef.current = L.marker(latlng, { icon: pickerIcon, zIndexOffset: 600 }).addTo(map);
      } else {
        markerRef.current.setLatLng(latlng);
      }
      map.panTo(latlng);
      onSelectRef.current({ lat: latlng.lat, lng: latlng.lng, label: "Buscando dirección…" });

      const requestId = ++requestRef.current;
      setSearchingAddress(true);
      let label = "Ubicación seleccionada en el mapa";
      try {
        label = (await reverseGeocode(latlng.lat, latlng.lng)) ?? label;
      } catch {
        // Sin conexión: se mantiene un texto genérico; las coordenadas siguen guardadas
      }
      if (requestId !== requestRef.current) return;
      onSelectRef.current({ lat: latlng.lat, lng: latlng.lng, label });
      setSearchingAddress(false);
    });
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [center]);

  return (
    <div className="location-picker">
      <div className="picker-heading">
        <div>
          <span>UBICACIÓN DEL INCIDENTE</span>
          <strong>Toca el punto exacto en el mapa</strong>
        </div>
        {searchingAddress && <small>Buscando dirección…</small>}
      </div>
      <div className="picker-map-wrap">
        {!center && (
          <div className="picker-loading">
            <i />
            Buscando tu ubicación…
          </div>
        )}
        <div ref={containerRef} className="picker-map" />
        {gpsUnavailable && (
          <div className="picker-gps-warning">
            <Icon name="warning" size={13} />
            GPS no disponible: mostrando La Serena–Coquimbo
          </div>
        )}
      </div>
    </div>
  );
}

function ReportScreen({
  onBack,
  onSubmit,
}: {
  onBack: () => void;
  onSubmit: (incident: Incident) => Promise<void>;
}) {
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null);
  const [vehicles, setVehicles] = useState(1);
  const [heavy, setHeavy] = useState(false);
  const [blockage, setBlockage] = useState("Sin bloqueo");
  const [tipoReportado, setTipoReportado] = useState("Colisión");
  const [ninosReportados, setNinosReportados] = useState("no_determinada");
  const [rolReportante, setRolReportante] = useState("testigo");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (!selectedLocation || selectedLocation.label === "Buscando dirección…") {
      setError("Falta seleccionar la ubicación del accidente: toca el mapa o usa tu GPS.");
      return;
    }
    setSending(true);
    setError("");
    try {
      await onSubmit({
      id: `TEMP-${Date.now()}`,
      place: selectedLocation.label,
      severity: "INDETERMINADA",
      status: "ALERTA_OPERADOR",
      time: "ahora",
      date: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      camera: "APP-CIUDADANO",
      origin: "APP_CIUDADANO",
      vehicles,
      heavy,
      blockage,
      tipoReportado, ninosReportados, rolReportante,
      lat: selectedLocation.lat,
      lng: selectedLocation.lng,
      pin: { left: "43%", top: "44%" },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al comunicar con el servidor");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="screen scroll-screen">
      <Header
        title="Reportar incidente"
        subtitle="Ayúdanos a responder más rápido"
        onBack={onBack}
      />
      <form className="screen-content form-content" onSubmit={submit}>
        <LocationPicker onSelect={setSelectedLocation} />
        <button type="button" className="gps-loc-btn" onClick={() => {
          if (!navigator.geolocation) { setError("GPS no disponible: toca el mapa para señalar el lugar."); return; }
          setError("");
          navigator.geolocation.getCurrentPosition(({ coords }) => {
            setSelectedLocation({lat: coords.latitude, lng: coords.longitude,
              label: "Mi ubicación GPS (seleccionada)"});
          }, () => setError("No se pudo obtener la ubicación. Selecciona un punto en el mapa."),
          {enableHighAccuracy: true, timeout: 10000});
        }}>Usar mi ubicación GPS como lugar del accidente</button>
        <div className={`selected-place ${selectedLocation ? "ready" : ""}`}>
          <Icon name={selectedLocation ? "check" : "pin"} size={17} />
          <div>
            <span>{selectedLocation ? "PUNTO SELECCIONADO" : "FALTA SELECCIONAR EL PUNTO"}</span>
            <strong>{selectedLocation?.label || "Toca una calle o intersección en el mapa"}</strong>
          </div>
        </div>
        <fieldset>
          <legend>¿Qué ocurrió? (declaración del ciudadano)</legend>
          <select value={tipoReportado} onChange={e => setTipoReportado(e.target.value)}>
            <option>Colisión</option><option>Colisión múltiple</option><option>Vuelco</option>
            <option>Contacto leve</option><option>Otro</option>
          </select>
        </fieldset>
        <fieldset>
          <legend>¿Participaron niños o niñas? (sin verificar)</legend>
          <select value={ninosReportados} onChange={e => setNinosReportados(e.target.value)}>
            <option value="no_determinada">No sé</option>
            <option value="indicios_por_verificar">Sí, según lo que observé</option>
            <option value="sin_indicios">No observé niños</option>
          </select>
        </fieldset>
        <fieldset>
          <legend>¿Cómo te enteraste del accidente?</legend>
          <select value={rolReportante} onChange={e => setRolReportante(e.target.value)}>
            <option value="testigo">Soy testigo / lo presencié</option>
            <option value="involucrado">Estoy involucrado</option>
            <option value="tercero">Me informaron otras personas</option>
          </select>
        </fieldset>
        <fieldset>
          <legend>Cantidad de vehículos</legend>
          <div className="segmented">
            {[1, 2, 3, 4].map((n) => (
              <button
                type="button"
                className={vehicles === n ? "active" : ""}
                onClick={() => setVehicles(n)}
                key={n}
              >
                {n === 4 ? "4+" : n}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>
            Vehículos pesados <small>(camión, bus, carga)</small>
          </legend>
          <div className="segmented two">
            <button
              type="button"
              className={!heavy ? "active" : ""}
              onClick={() => setHeavy(false)}
            >
              No
            </button>
            <button type="button" className={heavy ? "active" : ""} onClick={() => setHeavy(true)}>
              Sí
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Bloqueo de la vía</legend>
          <div className="choice-list">
            {["Sin bloqueo", "Parcial (al menos 1 pista)", "Total o mayoritario"].map((item) => (
              <button
                type="button"
                className={blockage === item ? "selected" : ""}
                onClick={() => setBlockage(item)}
                key={item}
              >
                <i />
                {item}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="severity-preview">
          <p>REVISIÓN PRELIMINAR</p>
          <strong>La prioridad se evaluará al recibir el reporte</strong>
          <p>El reporte se registrará para que un operador lo revise.</p>
        </div>
        {!selectedLocation && <p role="status" className="sr-form-help">Antes de enviar, marca la ubicación tocando el mapa superior o elige usar tu GPS. Las demás opciones no seleccionan el lugar automáticamente.</p>}
        {error && <p role="alert" className="sr-form-error">{error}</p>}
        <button className="btn btn-red submit-btn" type="submit" disabled={sending}>
          <Icon name="alert" /> {sending ? "Enviando reporte…" : "Enviar reporte"}
        </button>
      </form>
    </div>
  );
}

function DetalleDerivacion({ servicios = [], movimientos = [] }: {
  servicios?: string[];
  movimientos?: TrackingMovement[];
}) {
  const relevantes = movimientos.filter(m => ["tomar", "derivar", "cerrar", "falsa"].includes(m.accion));
  if (!servicios.length && !relevantes.length) return null;
  const nombres: Record<string, string> = {
    tomar: "Operador tomó el caso",
    derivar: "Derivación registrada",
    cerrar: "Caso cerrado en el sistema",
    falsa: "Descartado como falsa alarma",
  };
  const formatear = (fecha: string) => {
    const d = new Date(fecha);
    return Number.isNaN(d.getTime()) ? fecha : d.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
  };
  return (
    <div className="safetyroad-derivacion" aria-label="Seguimiento desde el sistema">
      {servicios.length > 0 && (
        <p><strong>Servicios seleccionados:</strong> {servicios.join(", ")}</p>
      )}
      {relevantes.length > 0 && (
        <div className="safetyroad-movimientos">
          {relevantes.map((m, i) => (
            <div key={`${m.accion}-${m.fecha}-${i}`}>
              <strong>{nombres[m.accion] || m.accion}</strong>
              <span> · {formatear(m.fecha)}</span>
              {m.accion === "derivar" && m.servicios?.length ?
                <span> · {m.servicios.join(", ")}</span> : null}
            </div>
          ))}
        </div>
      )}
      <small>Derivación registrada en el expediente.</small>
    </div>
  );
}

// Historial de incidentes: tarjetas compactas y ficha independiente.
// Se alimenta de los registros locales sincronizados con el backend servidor.
type HistoryFilter = "Activos" | "Cerrados" | "Archivados";
const HISTORY_FILTERS: HistoryFilter[] = ["Activos", "Cerrados", "Archivados"];

function historyState(status: IncidentStatus): { label: string; tone: string; icon: string } {
  if (status === "CERRADO_ATENDIDO") return { label: "Atendido", tone: "resolved", icon: "check" };
  if (status === "CERRADO_FALSA_ALARMA") return { label: "Descartado", tone: "discarded", icon: "check" };
  if (status === "DERIVADO") return { label: "Derivado", tone: "derived", icon: "phone" };
  if (status === "EN_REVISION") return { label: "En revisión", tone: "review", icon: "shield" };
  return { label: "Pendiente", tone: "pending", icon: "alert" };
}

function historyPriority(record: AlertRecord, incident?: Incident): { label: string; tone: string } {
  if (record.status === "CERRADO_FALSA_ALARMA" && !incident) return { label: "Sin evaluación", tone: "none" };
  // Usa primero la prioridad sincronizada con el operador, después la sugerencia inicial.
  const suggested = (incident?.severity
    ? ({ GRAVE: "P1", MODERADA: "P2", LEVE: "P3", INDETERMINADA: "IND" } as Record<string, string>)[incident.severity]
    : undefined) || incident?.prioridadSugerida ||
    record.reason.match(/prioridad sugerida\s*(P[123]|IND)/i)?.[1] || "IND";
  if (suggested === "P1") return { label: "P1 · Grave", tone: "p1" };
  if (suggested === "P2") return { label: "P2 · Moderada", tone: "p2" };
  if (suggested === "P3") return { label: "P3 · Leve", tone: "p3" };
  return { label: "IND · Sin determinar", tone: "ind" };
}

function historyOrigin(record: AlertRecord, incident?: Incident): { label: string; icon: string; kind: string } {
  if (record.status === "CERRADO_FALSA_ALARMA" && !incident)
    return { label: "Alerta de sensor descartada", icon: "check", kind: "discarded" };
  if (incident?.origin === "APP_CIUDADANO" || /ciudadan|testigo/i.test(record.title + " " + record.reason))
    return { label: "Reporte ciudadano", icon: "pin", kind: "citizen" };
  return { label: "Alerta de sensor del celular", icon: "bolt", kind: "sensor" };
}

function historyTitle(record: AlertRecord, incident?: Incident): string {
  if (record.status === "CERRADO_FALSA_ALARMA" && !incident) return "Alerta cancelada";
  if (incident?.tipoReportado && incident.origin === "APP_CIUDADANO") return incident.tipoReportado;
  if (/ciudadan|testigo/i.test(record.title + " " + record.reason)) {
    return record.reason.split("·")[1]?.trim() || "Reporte ciudadano";
  }
  return "Movimiento sospechoso";
}

function historyMatches(record: AlertRecord, filter: HistoryFilter, archived: boolean): boolean {
  if (filter === "Archivados") return archived;
  if (archived) return false;
  const closed = record.status === "CERRADO_ATENDIDO" || record.status === "CERRADO_FALSA_ALARMA";
  return filter === "Cerrados" ? closed : !closed;
}

function historyReporter(value?: string): string {
  return ({ testigo: "Testigo", involucrado: "Persona involucrada", tercero: "Información de terceros" } as Record<string, string>)[value || ""] || value || "No informada";
}
function historyKids(value?: string): string {
  if (!value || value === "no_determinada" || value === "no_determinado") return "No determinado";
  if (value === "indicios_por_verificar") return "Indicios según testigo (sin verificar)";
  if (["si", "sí", "confirmada"].includes(value.toLowerCase())) return "Sí, según declaración (sin verificar)";
  if (value === "no") return "No observados según testigo";
  return value;
}
function historyTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

function AlertsScreen({ records, incidents, onBack, serverUrl }: {
  records: AlertRecord[]; incidents: Incident[]; onBack: () => void; serverUrl: string;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("Activos");
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [archiveOverride, setArchiveOverride] = useState<Record<string, boolean>>({});
  const [archiving, setArchiving] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState("");
  const key = (r: AlertRecord) => r.trackingToken || r.incidentId || String(r.id);
  const isArchived = (r: AlertRecord) => archiveOverride[key(r)] ?? Boolean(r.archivado);
  const isClosed = (r: AlertRecord) => r.status.startsWith("CERRADO");
  const archive = async (chosen: AlertRecord[], value: boolean) => {
    const eligible = chosen.filter(r => isClosed(r) && r.trackingToken && isArchived(r) !== value);
    if (!eligible.length) { setArchiveNotice("No hay casos cerrados con seguimiento para esta acción."); return; }
    if (!window.confirm(value ? `¿Archivar ${eligible.length} caso(s) cerrado(s)? Seguirán guardados para las estadísticas y podrán recuperarse.` : `¿Restaurar ${eligible.length} caso(s) al historial de cerrados?`)) return;
    setArchiving(true); setArchiveNotice("");
    try {
      const result = await requestSafetyRoad<{actualizados: string[]; total: number}>(
        "/api/app/archivar", "POST", {tokens: eligible.map(r => r.trackingToken), archivado: value}, serverUrl);
      const changedIds = new Set(result.actualizados || []);
      const updated = eligible.filter(r => r.incidentId && changedIds.has(r.incidentId));
      // El identificador de evento puede faltar en tarjetas antiguas: el servidor
      // valida cada token; si contestó correctamente, actualizar las correspondientes.
      const accepted = updated.length ? updated : eligible;
      setArchiveOverride(prev => ({...prev, ...Object.fromEntries(accepted.map(r => [key(r), value]))}));
      setOpenedId(null);
      setArchiveNotice(value ? `${result.total} caso(s) archivado(s). Los indicadores no cambiaron.` : `${result.total} caso(s) recuperado(s).`);
    } catch (err) {
      setArchiveNotice(err instanceof Error ? err.message : "No se pudo conectar con el servicio.");
    } finally { setArchiving(false); }
  };
  useEffect(() => {
    // Once the server-synchronized record matches the optimistic local view,
    // release the temporary override so future operator changes are reflected.
    setArchiveOverride(prev => {
      const next = {...prev}; let changed = false;
      for (const record of records) {
        const k = key(record);
        if (Object.prototype.hasOwnProperty.call(next, k) && Boolean(record.archivado) === next[k]) {
          delete next[k];changed=true;
        }
      }
      return changed ? next : prev;
    });
  }, [records]);
  const opened = records.find(record => record.id === openedId);
  const findIncident = (record: AlertRecord): Incident | undefined =>
    incidents.find(i => record.incidentId && i.id === record.incidentId) ||
    incidents.find(i => record.trackingToken && (i.trackingToken === record.trackingToken || i.token === record.trackingToken));
  const rendered = records.filter(record => historyMatches(record, filter, isArchived(record)));

  if (opened) {
    const incident = findIncident(opened);
    const priority = historyPriority(opened, incident);
    const state = historyState(opened.status);
    const origin = historyOrigin(opened, incident);
    const messages: { label: string; value: string }[] = [
      { label: "Origen", value: origin.label },
      { label: "ID del expediente", value: opened.incidentId || incident?.id || "Sin identificador asociado" },
      { label: "Fecha y hora", value: opened.date },
      { label: "Ubicación declarada", value: incident?.place || "No registrada" },
      { label: "Relación con el accidente", value: historyReporter(incident?.rolReportante) },
      { label: "Tipo reportado", value: incident?.tipoReportado || (origin.kind === "sensor" ? "Movimiento brusco" : "No informado") },
      { label: "Vehículos", value: incident ? String(incident.vehicles) : "No informado" },
      { label: "Vehículo pesado", value: incident ? (incident.heavy ? "Sí, declarado" : "No declarado") : "No informado" },
      { label: "Bloqueo de vía", value: incident?.blockage || "No informado" },
      { label: "Niños involucrados", value: historyKids(incident?.ninosReportados) },
    ];
    return (
      <div className="screen scroll-screen sr-history-v2">
        <Header title="Detalle del reporte" subtitle="Información y seguimiento del expediente" onBack={() => setOpenedId(null)} />
        <main className="screen-content sr-history-detail">
          <section className={`sr-history-hero sr-priority-${priority.tone}`}>
            <div className="sr-history-hero-top">
              <span className={`sr-history-type-icon sr-kind-${origin.kind}`}><Icon name={origin.icon} size={23}/></span>
              <span className={`sr-history-pill sr-status-${state.tone}`}><Icon name={state.icon} size={13}/>{state.label}</span>
            </div>
            <p className="sr-history-eyebrow">{origin.label}</p>
            <h2>{historyTitle(opened, incident)}</h2>
            <span className={`sr-history-pill sr-priority-pill sr-priority-${priority.tone}`}>{priority.label}</span>
            <p className="sr-history-caveat">Prioridad preliminar, no es una gravedad confirmada.</p>
          </section>
          <section className="sr-history-section">
            <h3>Datos del reporte</h3>
            <div className="sr-history-facts">
              {messages.map(item => (
                <div className="sr-history-fact" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
              ))}
            </div>
          </section>
          <section className="sr-history-section">
            <h3>Descripción original</h3>
            <p className="sr-history-description">{opened.reason}</p>
          </section>
          <section className="sr-history-section">
            <h3>Seguimiento del operador</h3>
            <div className="sr-history-timeline">
              <div className="sr-history-timeline-item"><span className="sr-history-step-dot"/><div><strong>Reporte registrado</strong><small>{opened.date}</small></div></div>
              {(opened.movimientos || []).map((m, index) => (
                <div className="sr-history-timeline-item" key={`${m.fecha}-${index}`}>
                  <span className="sr-history-step-dot"/>
                  <div><strong>{m.accion === "tomar" ? "Caso en revisión" : m.accion === "derivar" ? "Derivación registrada" : m.accion === "cerrar" ? "Caso cerrado como atendido" : m.accion === "falsa" ? "Descartado" : m.accion}</strong>
                  <small>{historyTime(m.fecha)}</small>
                  {m.servicios && m.servicios.length > 0 && <small>{m.servicios.join(" · ")}</small>}</div>
                </div>
              ))}
              {(!opened.movimientos || opened.movimientos.length === 0) && <p className="sr-history-no-actions">Sin actuaciones del operador registradas todavía.</p>}
            </div>
            {opened.serviciosDerivados && opened.serviciosDerivados.length > 0 && (
              <div className="sr-history-services"><Icon name="phone" size={18}/><div><strong>Servicios seleccionados</strong><p>{opened.serviciosDerivados.join(" · ")}</p></div></div>
            )}
          </section>
          {isClosed(opened) && opened.trackingToken && (
            <button type="button" className="sr-history-archive-button" disabled={archiving} onClick={() => void archive([opened], !isArchived(opened))}>
              <Icon name="check" size={15}/>{isArchived(opened) ? "Restaurar al historial" : "Archivar este caso cerrado"}
            </button>
          )}
          {archiveNotice && <p className="sr-history-footnote" role="status">{archiveNotice}</p>}
          <p className="sr-history-safety-note"><Icon name="shield" size={15}/> Entorno de pruebas: las derivaciones registradas no realizan despachos externos.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="screen scroll-screen sr-history-v2">
      <Header title="Historial de alertas" subtitle="Seguimiento de tus alertas y reportes" onBack={onBack} />
      <main className="screen-content sr-history-content">
        <div className="sr-history-heading"><div><h2>Seguimiento</h2><p>Casos resumidos. Toca para ver los detalles.</p></div><span>{rendered.length} visibles</span></div>
        <div className="sr-history-tools">
          <span>Los cerrados pueden archivarse sin borrar estadísticas.</span>
          <button type="button" disabled={archiving} onClick={() => void archive(records.filter(r => isClosed(r) && !isArchived(r)), true)}>Limpiar cerradas</button>
        </div>
        {archiveNotice && <p className="sr-history-footnote" role="status">{archiveNotice}</p>}
        <div className="sr-history-filters" aria-label="Filtrar por estado">
          {HISTORY_FILTERS.map(item => <button type="button" key={item} onClick={() => setFilter(item)} className={filter === item ? "active" : ""} aria-pressed={filter === item}>{item}</button>)}
        </div>
        {rendered.length === 0 ? (
          <div className="sr-history-empty"><Icon name="shield" size={30}/><h3>No hay reportes en esta categoría</h3><p>{records.length ? "Prueba otro filtro." : "Cuando envíes un reporte, aparecerá aquí."}</p></div>
        ) : (
          <div className="sr-history-list">
            {rendered.map(r => {
              const incident = findIncident(r);
              const priority = historyPriority(r, incident);
              const state = historyState(r.status);
              const origin = historyOrigin(r, incident);
              return (
                <button type="button" key={r.id} className={`sr-history-card sr-priority-${priority.tone}`} onClick={() => setOpenedId(r.id)} aria-label={`Ver detalle de ${historyTitle(r, incident)}; ${state.label}`}>
                  <div className="sr-history-card-top">
                    <span className={`sr-history-type-icon sr-kind-${origin.kind}`}><Icon name={origin.icon} size={23}/></span>
                    <div className="sr-history-card-title"><strong>{historyTitle(r, incident)}</strong><small>{origin.label}</small></div>
                    <Icon name="chevron" size={17}/>
                  </div>
                  <div className="sr-history-labels">
                    <span className={`sr-history-pill sr-priority-pill sr-priority-${priority.tone}`}>{priority.label}</span>
                    <span className={`sr-history-pill sr-status-${state.tone}`}><Icon name={state.icon} size={13}/>{state.label}</span>
                  </div>
                  <div className="sr-history-card-foot"><span><Icon name="pin" size={13}/>{incident?.place || (origin.kind === "citizen" ? "Ubicación pendiente" : "Ubicación no registrada")}</span><time>{r.date}</time></div>
                </button>
              );
            })}
          </div>
        )}
        <p className="sr-history-footnote">Archivar oculta casos cerrados en ambas vistas, pero no elimina expedientes ni estadísticas. Solo se sincronizan reportes con código de seguimiento conservado.</p>
      </main>
    </div>
  );
}

function ZoneScreen({
  radius,
  onBack,
  onSave,
}: {
  radius: number;
  onBack: () => void;
  onSave: (n: number) => void;
}) {
  const [value, setValue] = useState(radius);
  return (
    <div className="screen">
      <Header title="Mi Zona" subtitle="Define tu radio de monitoreo" onBack={onBack} />
      <div className="zone-preview">
        <MapArtwork incidents={[]} radius={value} onIncident={() => {}} />
        <div className="zone-preview-label">
          <span>Radio actual</span>
          <strong>{value.toFixed(1).replace(".", ",")} km</strong>
        </div>
      </div>
      <main className="zone-controls">
        <div className="range-heading">
          <div>
            <p className="eyebrow">RADIO DE ALERTA</p>
            <h2>Área de cobertura</h2>
          </div>
          <strong>{value.toFixed(1).replace(".", ",")} km</strong>
        </div>
        <input
          className="range"
          type="range"
          min=".5"
          max="5"
          step=".5"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-label="Radio de alerta"
        />
        <div className="range-labels">
          <span>0,5 km</span>
          <span>5 km</span>
        </div>
        <p className="helper">
          Recibirás alertas de incidentes que ocurran dentro de esta zona alrededor de tu ubicación.
        </p>
        <button className="btn btn-red" onClick={() => onSave(value)}>
          Guardar zona
        </button>
      </main>
    </div>
  );
}

function MetricsScreen({ onBack, incidents, metrics, error, operational }: {
  onBack: () => void;
  incidents: Incident[];
  metrics: ApiMetric[];
  error: string;
  operational: Record<string, number | string | null>;
}) {
  return (
    <div className="screen scroll-screen">
      <Header title="Indicadores" subtitle="Resultados del sistema" onBack={onBack} />
      <main className="screen-content">
        <div className="metric-summary">
          <p>INDICADORES CENTRALIZADOS</p>
          <strong>{metrics.length || "—"}</strong>
          <span>calculados o declarados pendientes por el backend</span>
        </div>
        {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
        <div className="metric-summary" style={{ marginBottom: 12 }}>
          <p>TIEMPOS OPERATIVOS</p>
          <span>Procesamiento: {operational.procesamiento_python_ms ?? "—"} ms · Primera vista: {operational.registro_a_primera_vista_s ?? "—"} s · Derivación: {operational.registro_a_derivacion_s ?? "—"} s.</span>
          <span>Reportes ciudadanos descartados: {operational.reportes_ciudadanos_descartados ?? 0}/{operational.reportes_ciudadanos_total ?? 0} ({operational.reportes_ciudadanos_descartados_pct ?? "—"} %)</span>
          <span>No son tiempo de red ni de llegada de servicios.</span>
        </div>
        <div className="metrics-grid">
          {metrics.map((metric, index) => (
            <article className="metric-card" key={metric.name || index}>
              <div>
                <span>{metric.name || metric.nombre || `Indicador ${index + 1}`}</span>
                <Chip tone={metric.measured ? "green" : "gray"}>
                  {metric.measured ? "CALCULADO" : "SIN MEDIR"}
                </Chip>
              </div>
              <strong>{metric.value}</strong>
              <p>{metric.note}</p>
              <p>Meta: {metric.target || metric.meta || "Por definir"}</p>
            </article>
          ))}
        </div>
        {!metrics.length && <p className="metrics-note">Sin conexión con el servicio: no hay indicadores disponibles.</p>}
        <p className="metrics-note">Los indicadores pendientes requieren datos validados.</p>
      </main>
    </div>
  );
}

function SettingsScreen({
  settings,
  onBack,
  onSave,
  onRevoke,
  onTest,
}: {
  settings: { contact: string; emergency: string; sensitivity: string; serverUrl: string };
  onBack: () => void;
  onSave: (s: { contact: string; emergency: string; sensitivity: string; serverUrl: string }) => void;
  onRevoke: () => void;
  onTest: (url: string) => Promise<string>;
}) {
  const [form, setForm] = useState(settings);
  const [testStatus, setTestStatus] = useState("");
  return (
    <div className="screen scroll-screen">
      <Header title="Configuración" subtitle="Cobertura y detección de impactos" onBack={onBack} />
      <main className="screen-content form-content settings-form">
        <section>
          <p className="eyebrow">CONEXIÓN AL SERVICIO</p>
          <h2>Servidor SafetyRoad</h2>
          <label className="field">
            <span>Dirección IP del computador en la red Wi-Fi (ejemplo: http://192.168.1.10:8765)</span>
            <input type="url" value={form.serverUrl || ""}
              onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
              placeholder="http://192.168.1.10:8765" />
          </label>
          <button type="button" className="btn btn-ghost" onClick={async () => {
            setTestStatus("Comprobando…");
            try { setTestStatus(await onTest(form.serverUrl)); }
            catch (e) { setTestStatus(e instanceof Error ? e.message : "No se pudo conectar"); }
          }}>Comprobar conexión</button>
          {testStatus && <p role="status">{testStatus}</p>}
          <p>Solo usar en una red local de pruebas. El detector es experimental, funciona únicamente mientras la app está activa y NO contacta a emergencias.</p>
        </section>
        <section>
          <p className="eyebrow">CONTACTOS</p>
          <h2>Asistencia de emergencia</h2>
          <label className="field">
            <span>Contacto de emergencia</span>
            <input
              type="tel"
              value={form.contact}
              onChange={(e) => setForm({ ...form, contact: e.target.value })}
              placeholder="+56 9 1234 5678"
            />
          </label>
          <label className="field">
            <span>Número de emergencia</span>
            <select
              value={form.emergency}
              onChange={(e) => setForm({ ...form, emergency: e.target.value })}
            >
              <option>131 – SAMU</option>
              <option>133 – Carabineros</option>
              <option>132 – Bomberos</option>
            </select>
          </label>
        </section>
        <section>
          <p className="eyebrow">DETECCIÓN</p>
          <h2>Sensibilidad del impacto</h2>
          <div className="radio-cards">
            {[
              ["Alta", "2 G", "Detecta impactos más leves"],
              ["Media", "3 G", "Equilibrio recomendado"],
              ["Baja", "4 G", "Solo impactos fuertes"],
            ].map(([name, g, desc]) => (
              <button
                key={name}
                className={form.sensitivity === name ? "selected" : ""}
                onClick={() => setForm({ ...form, sensitivity: name })}
              >
                <i />
                <div>
                  <strong>
                    {name} <span>{g}</span>
                  </strong>
                  <p>{desc}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
        <button className="btn btn-red" onClick={() => onSave(form)}>
          Guardar configuración
        </button>
        <button className="btn btn-ghost danger-text" onClick={onRevoke}>
          Revocar consentimiento
        </button>
      </main>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("map");
  const [menuOpen, setMenuOpen] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>(() =>
    load<Incident[]>("sr_incidents", INITIAL_INCIDENTS).filter((incident) => !incident.id.startsWith("INC-2025-")).map((incident) => ({
      ...incident,
      trackingToken: incident.trackingToken || incident.token,
    }))
  );
  const [selectedId, setSelectedId] = useState("");
  const [impactOpen, setImpactOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(() => load("sr_consent", null as boolean | null) === null);
  const [consent, setConsent] = useState<boolean>(() => load("sr_consent", false));
  const [radius, setRadius] = useState<number>(() => load("sr_radius", 1.5));
  const [toast, setToast] = useState("");
  const [alerts, setAlerts] = useState<AlertRecord[]>(() => load("sr_alerts", []));
  const [apiMetrics, setApiMetrics] = useState<ApiMetric[]>([]);
  const [apiMetricsError, setApiMetricsError] = useState("");
  const [operational, setOperational] = useState<Record<string, number | string | null>>({});
  const [settings, setSettings] = useState(() => ({
    contact: "", emergency: "131 – SAMU", sensitivity: "Media", serverUrl: "",
    ...load("sr_settings", {} as Record<string, string>),
  }));
  const selected = incidents.find((i) => i.id === selectedId) || incidents[0];

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const lastPos = useRef<{ lat: number; lng: number } | null>(null);
  const impactOpenRef = useRef(false);
  impactOpenRef.current = impactOpen;

  useEffect(() => save("sr_incidents", incidents), [incidents]);
  useEffect(() => save("sr_alerts", alerts), [alerts]);
  useEffect(() => save("sr_radius", radius), [radius]);
  useEffect(() => save("sr_settings", settings), [settings]);
  useEffect(() => save("sr_consent", consent), [consent]);

  useEffect(() => {
    if (screen !== "metrics") return;
    setApiMetricsError("");
    requestSafetyRoad<{ metrics: ApiMetric[]; tiempos_operativos: Record<string, number | string | null> }>("/api/app/indicadores", "GET", undefined, settings.serverUrl)
      .then((r) => {setApiMetrics(r.metrics);setOperational(r.tiempos_operativos || {});})
      .catch((err) => { setApiMetrics([]); setApiMetricsError(err instanceof Error ? err.message : "Sin conexión"); });
  }, [screen, settings.serverUrl]);

  // Sincronización con el servidor. Las cancelaciones locales cuentan como descartes
  // experimentales, SIN generar una notificación a emergencias.
  // Los casos antiguos sin token sólo se reconcilian si la fecha/minuto permite
  // encontrar UNA coincidencia única entre los casos de la app.
  useEffect(() => {
    let active = true;
    let busy = false;
    const norm = (v: unknown) => String(v || "").toLowerCase().replace(/[.,\s]/g, "");
    const timeText = (v: string) => {
      try { return new Date(v).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }); }
      catch { return ""; }
    };
    type ServerCase = {
      id: string; source: string; origen?: string; created_at: string;
      st: string; p: string; servicios?: string[]; archivado?: boolean;
      historial?: Array<{ fecha: string; accion: string; a?: string; detalle?: string | string[] }>;
    };
    const legacyMatch = (date: string, events: ServerCase[]) => {
      const candidates = events.filter(e => e.source === "APP" && e.origen === "app_sensor"
        && norm(timeText(e.created_at)) === norm(date));
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const sync = async () => {
      if (busy || !active) return;
      busy = true;
      try {
        const records = load<AlertRecord[]>("sr_alerts", []);
        for (const record of records) {
          if (!active) return;
          if (record.status !== "CERRADO_FALSA_ALARMA" || record.trackingToken ||
              !record.title.toLowerCase().includes("cancelad")) continue;
          const clientId = `cancel_${String(record.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 70)}`;
          try {
            const answer = await requestSafetyRoad<{ token: string; id: string; estado: IncidentStatus }>(
              "/api/app/cancelar", "POST", { client_event_id: clientId }, settings.serverUrl);
            if (!active) return;
            setAlerts(prev => prev.map(r => r.id === record.id ? {
              ...r, trackingToken: answer.token, incidentId: answer.id,
              status: answer.estado, reason: "Cancelada desde la aplicación",
            } : r));
          } catch { /* Reintentar cuando el servidor vuelva a estar disponible. */ }
        }
        const tracked = load<Incident[]>("sr_incidents", []).filter(i => i.trackingToken || i.token);
        const followups = await Promise.all(tracked.map(async item => {
          const token = item.trackingToken || item.token || "";
          try {
            const response = await requestSafetyRoad<TrackingResponse>(
              `/api/app/seguimiento?token=${encodeURIComponent(token)}`,
              "GET", undefined, settings.serverUrl);
            return { token, response };
          } catch { return null; }
        }));
        if (!active) return;
        const byToken = new Map(followups.filter((r): r is NonNullable<typeof r> => r !== null)
          .map(r => [r.token, r.response]));
        let remote: ServerCase[] = [];
        try {
          const state = await requestSafetyRoad<{ events: ServerCase[] }>(
            "/api/estado", "GET", undefined, settings.serverUrl);
          remote = state.events || [];
        } catch { /* Puede estar sin conexión. */ }
        if (!active) return;
        setIncidents(prev => prev.map(item => {
          const token = item.trackingToken || item.token || "";
          const answer = byToken.get(token);
          const legacy = !answer ? remote.find(e => e.id === item.id)
            || ((item.camera === "APP-IMPACTO" || item.origin === "APP_IMPACTO")
              ? legacyMatch(item.date, remote) : undefined) : undefined;
          if (!answer && !legacy) return item;
          const nextId = answer?.id || legacy!.id;
          const nextStatus = ((answer?.estado || legacy!.st) === "DERIVADO_SIMULADO"
            ? "DERIVADO" : (answer?.estado || legacy!.st)) as IncidentStatus;
          const p = answer?.prioridad || legacy!.p;
          const serviciosDerivados = answer?.servicios || legacy?.servicios || [];
          const movimientos: TrackingMovement[] = answer?.movimientos ||
            (legacy?.historial || []).map(m => ({
              fecha: m.fecha, accion: m.accion, estado: m.a,
              servicios: m.accion === "derivar" && Array.isArray(m.detalle) ? m.detalle : []
            }));
          const archivado = Boolean(answer?.archivado ?? legacy?.archivado ?? item.archivado);
          if (item.status === nextStatus && item.id === nextId && Boolean(item.archivado) === archivado &&
              JSON.stringify(item.serviciosDerivados || []) === JSON.stringify(serviciosDerivados) &&
              JSON.stringify(item.movimientos || []) === JSON.stringify(movimientos)) return item;
          return { ...item, id: nextId, status: nextStatus, archivado,
            serviciosDerivados, movimientos,
            severity: p === "P1" ? "GRAVE" : p === "P2" ? "MODERADA" : p === "P3" ? "LEVE" : "INDETERMINADA" };
        }));
        setAlerts(prev => prev.map(record => {
          let token = record.trackingToken;
          if (!token && record.status !== "CERRADO_FALSA_ALARMA") {
            const matches = tracked.filter(t => t.date === record.date &&
              (t.camera === "APP-IMPACTO" || t.origin === "APP_IMPACTO"));
            if (matches.length === 1) token = matches[0].trackingToken || matches[0].token;
          }
          const answer = token ? byToken.get(token) : undefined;
          const legacy = !answer ? remote.find(e => e.id === record.incidentId)
            || (record.status !== "CERRADO_FALSA_ALARMA" ? legacyMatch(record.date, remote) : undefined) : undefined;
          if (!answer && !legacy) return record;
          const nextId = answer?.id || legacy!.id;
          const nextStatus = ((answer?.estado || legacy!.st) === "DERIVADO_SIMULADO"
            ? "DERIVADO" : (answer?.estado || legacy!.st)) as IncidentStatus;
          const serviciosDerivados = answer?.servicios || legacy?.servicios || [];
          const movimientos: TrackingMovement[] = answer?.movimientos ||
            (legacy?.historial || []).map(m => ({
              fecha: m.fecha, accion: m.accion, estado: m.a,
              servicios: m.accion === "derivar" && Array.isArray(m.detalle) ? m.detalle : []
            }));
          const archivado = Boolean(answer?.archivado ?? legacy?.archivado ?? record.archivado);
          if (record.status === nextStatus && record.incidentId === nextId && record.trackingToken === token && Boolean(record.archivado) === archivado &&
              JSON.stringify(record.serviciosDerivados || []) === JSON.stringify(serviciosDerivados) &&
              JSON.stringify(record.movimientos || []) === JSON.stringify(movimientos)) return record;
          return { ...record, status: nextStatus, trackingToken: token,
            incidentId: nextId, archivado, serviciosDerivados, movimientos };
        }));
      } finally { busy = false; }
    };
    void sync();
    const timer = window.setInterval(() => { void sync(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [settings.serverUrl]);

  useEffect(() => {
    if (!consent || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      ({ coords }) => {
        lastPos.current = { lat: coords.latitude, lng: coords.longitude };
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [consent]);

  useEffect(() => {
    if (!consent) return;
    const limit = SENSITIVITY_MS2[settings.sensitivity] ?? 30;
    let lastAlert = 0;
    let lastHit = 0;
    let consecutiveHits = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      // Sólo la aceleración lineal: accelerationIncludingGravity incluye ~9.81 m/s².
      // Dos muestras cercanas reducen falsas alarmas, pero NO verifican un choque.
      const a = e.acceleration;
      if (!a || impactOpenRef.current) return;
      const g = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
      const now = Date.now();
      if (g >= limit) {
        consecutiveHits = now - lastHit <= 600 ? consecutiveHits + 1 : 1;
        lastHit = now;
        if (consecutiveHits >= 2 && now - lastAlert > 15000) {
          lastAlert = now;
          consecutiveHits = 0;
          setImpactOpen(true);
        }
      } else if (now - lastHit > 600) {
        consecutiveHits = 0;
      }
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [consent, settings.sensitivity]);

  const openIncident = (incident: Incident) => {
    setSelectedId(incident.id);
    setScreen("detail");
    setMenuOpen(false);
  };
  const resolveImpact = async (needHelp: boolean) => {
    setImpactOpen(false);
    const now = new Date().toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
    if (needHelp) {
      const impact: Incident = {
        id: `IMP-${Date.now()}`,
        place: lastPos.current ? "Ubicación GPS del dispositivo" : "Sin ubicación GPS",
        severity: "INDETERMINADA",
        status: "ALERTA_OPERADOR",
        time: "ahora",
        date: now,
        createdAt: new Date().toISOString(),
        camera: "APP-IMPACTO",
        origin: "APP_IMPACTO",
        vehicles: 1,
        heavy: false,
        blockage: "Por verificar",
        lat: lastPos.current?.lat ?? NaN,
        lng: lastPos.current?.lng ?? NaN,
        pin: { left: "48%", top: "50%" },
      };
      try {
        const respuesta = await requestSafetyRoad<ReportResponse>("/api/app/reportar", "POST", {
          origen: "app_sensor",
          tipo: "Movimiento sospechoso",
          ubicacion: lastPos.current
            ? `GPS ${lastPos.current.lat.toFixed(5)}, ${lastPos.current.lng.toFixed(5)}`
            : "Ubicación no disponible (GPS sin datos)",
          lat: lastPos.current?.lat,
          lng: lastPos.current?.lng,
          vehiculos: 0,
          bloqueo: "No determinado",
          descripcion: "La persona solicitó ayuda tras una alerta experimental de movimiento. Gravedad por verificar.",
          requiere_asistencia: true,
        }, settings.serverUrl);
        setIncidents((items) => [{ ...impact, id: respuesta.id,
          trackingToken: respuesta.token, prioridadSugerida: respuesta.sugerencia }, ...items]);
        setAlerts((a) => [{ id: Date.now(), title: "Alerta de sensor registrada",
          status: respuesta.estado || "ALERTA_OPERADOR", date: now,
          trackingToken: respuesta.token, incidentId: respuesta.id,
          reason: "Movimiento brusco; no confirma choque" }, ...a]);
        setToast(`Alerta de sensor ${respuesta.id} registrada; pendiente de revisión.`);
      } catch (err) {
        setToast(`No se registró el aviso: ${err instanceof Error ? err.message : "sin conexión con el servidor"}`);
      }
    } else {
      setAlerts((a) => [
        {
          id: Date.now(),
          title: "Alerta local cancelada",
          status: "CERRADO_FALSA_ALARMA",
          date: now,
          reason: "Cancelada por el usuario; actualizando indicador",
        },
        ...a,
      ]);
      setToast("Alerta cancelada. Se registrará el descarte en el sistema sin avisar a emergencias.");
    }
  };
  const updateIncident = (status: IncidentStatus) => {
    setIncidents((items) => items.map((i) => (i.id === selectedId ? { ...i, status } : i)));
    setToast(`Estado actualizado a ${status}`);
  };
  const navigate = (target: Screen) => {
    setScreen(target);
    setMenuOpen(false);
  };

  const screenContent = useMemo(() => {
    if (screen === "detail")
      return (
        <DetailScreen
          incident={selected}
          onBack={() => setScreen("map")}
          onUpdate={updateIncident}
        />
      );
    if (screen === "report")
      return (
        <ReportScreen
          onBack={() => setScreen("map")}
          onSubmit={async (incident) => {
            const bloqueo = incident.blockage === "Sin bloqueo" ? "No"
              : incident.blockage.startsWith("Parcial") ? "Parcial" : "Total";
            const descripcion = `${incident.vehicles} vehículo(s); pesado: ${incident.heavy ? "sí" : "no"}; bloqueo: ${incident.blockage}. Reporte ciudadano sin verificación.`;
            const respuesta = await requestSafetyRoad<ReportResponse>("/api/app/reportar", "POST", {
              origen: "app_manual", tipo: incident.tipoReportado || "Otro", ubicacion: incident.place,
              lat: incident.lat, lng: incident.lng, vehiculos: incident.vehicles,
              vehiculo_pesado: incident.heavy, bloqueo,
              ninos: incident.ninosReportados || "no_determinada",
              rol_reportante: incident.rolReportante || "testigo", descripcion,
            }, settings.serverUrl);
            if (!respuesta.ok || !respuesta.id || !respuesta.token)
              throw new Error("servidor no confirmó el registro. No se añadió el reporte.");
            const sugerencia = respuesta.prioridad || respuesta.sugerencia || "IND";
            const gravedad = sugerencia === "P1" ? "GRAVE" : sugerencia === "P2" ? "MODERADA" : sugerencia === "P3" ? "LEVE" : "INDETERMINADA";
            setIncidents((items) => [{ ...incident, id: respuesta.id, createdAt: new Date().toISOString(),
              status: respuesta.estado || "ALERTA_OPERADOR", severity: gravedad,
              trackingToken: respuesta.token, prioridadSugerida: sugerencia }, ...items]);
            setAlerts(items => [{ id: Date.now(), title: "Reporte ciudadano enviado",
              status: respuesta.estado || "ALERTA_OPERADOR", date: new Date().toLocaleString("es-CL"),
              reason: `${incident.rolReportante === "testigo" ? "Testigo" : "Ciudadano"} · ${incident.tipoReportado || "Posible accidente"} · Prioridad sugerida ${sugerencia} (sin confirmar)`,
              trackingToken: respuesta.token, incidentId: respuesta.id }, ...items]);
            setScreen("map");
            setToast(`Reporte ${respuesta.id} recibido. Prioridad sugerida: ${sugerencia} (sin verificar).`);
          }}
        />
      );
    if (screen === "alerts")
      return <AlertsScreen records={alerts} incidents={incidents} serverUrl={settings.serverUrl} onBack={() => setScreen("map")} />;
    if (screen === "zone")
      return (
        <ZoneScreen
          radius={radius}
          onBack={() => setScreen("map")}
          onSave={(value) => {
            setRadius(value);
            setScreen("map");
            setToast(`Zona actualizada a ${value.toFixed(1).replace(".", ",")} km.`);
          }}
        />
      );
    if (screen === "metrics")
      return <MetricsScreen incidents={incidents} metrics={apiMetrics}
        error={apiMetricsError} operational={operational} onBack={() => setScreen("map")} />;
    if (screen === "settings")
      return (
        <SettingsScreen
          settings={settings}
          onBack={() => setScreen("map")}
          onSave={(value) => {
            setSettings(value);
            setScreen("map");
            setToast("Configuración guardada.");
          }}
          onTest={async (url) => {
            const result = await requestSafetyRoad<{ ok: boolean; modo: string }>("/api/salud", "GET", undefined, url);
            if (!result.ok) throw new Error("servidor no respondió correctamente");
            return `Conectado al sistema (${result.modo}). Sin llamadas de emergencia.`;
          }}
          onRevoke={() => {
            setConsentOpen(true);
            setConsent(false);
            setToast("Consentimiento revocado.");
          }}
        />
      );
    return null;
  }, [screen, selected, alerts, radius, incidents, settings, apiMetrics, apiMetricsError]);

  return (
    <div className="app-shell">
      <div className="phone">
        {screen === "map" ? (
          <div className="map-screen">
            <header className="main-header">
              <button
                className={`menu-button ${menuOpen ? "active" : ""}`}
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Abrir menú"
              >
                <Icon name={menuOpen ? "close" : "menu"} />
              </button>
              <div className="brand">
                <h1>
                  SafetyRoad <span>2.0</span>
                </h1>
                <p>
                  <i /> {consent ? "Sensores (solo con app abierta)" : "Protección desactivada"}
                </p>
              </div>
              <div className="shield-status">
                <Icon name="shield" size={19} />
              </div>
            </header>
            <div className="map-wrap">
              <MapArtwork incidents={incidents} radius={radius} onIncident={openIncident} main />
              <button className="simulate-btn" onClick={() => setImpactOpen(true)}>
                <Icon name="bolt" size={15} /> Probar alerta
              </button>
              {menuOpen && <div className="map-dim" onClick={() => setMenuOpen(false)} />}
              {menuOpen && (
                <nav className="floating-menu">
                  <p className="menu-label">NAVEGACIÓN</p>
                  <button onClick={() => navigate("alerts")}>
                    <span>
                      <Icon name="alert" />
                    </span>
                    <div>
                      <strong>Historial de Alertas</strong>
                      <small>Tus detecciones</small>
                    </div>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button onClick={() => navigate("zone")}>
                    <span>
                      <Icon name="pin" />
                    </span>
                    <div>
                      <strong>Mi Zona</strong>
                      <small>Radio de cobertura</small>
                    </div>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button onClick={() => navigate("report")}>
                    <span>
                      <Icon name="warning" />
                    </span>
                    <div>
                      <strong>Reportar Incidente</strong>
                      <small>Informar un evento</small>
                    </div>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button onClick={() => navigate("metrics")}>
                    <span>
                      <Icon name="chart" />
                    </span>
                    <div>
                      <strong>Indicadores</strong>
                      <small>Rendimiento</small>
                    </div>
                    <Icon name="chevron" size={16} />
                  </button>
                  <div className="menu-divider" />
                  <button className="menu-minor" onClick={() => navigate("settings")}>
                    <Icon name="settings" size={17} /> Configuración de cobertura
                  </button>
                  <button className="menu-minor" onClick={() => setMenuOpen(false)}>
                    <Icon name="close" size={17} /> Cerrar menú
                  </button>
                </nav>
              )}
            </div>
            <BottomSheet
              incidents={incidents}
              onIncident={openIncident}
            />
          </div>
        ) : (
          screenContent
        )}
        {impactOpen && <ImpactModal onResolve={resolveImpact} />}
        {consentOpen && (
          <ConsentModal
            onChoice={(accepted) => {
              setConsentOpen(false);
              setConsent(accepted);
              setToast(
                accepted
                  ? "Protección activada correctamente."
                  : "Protección desactivada. Puedes activarla luego.",
              );
            }}
          />
        )}
        {toast && (
          <div className="toast">
            <Icon name="check" size={17} />
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
