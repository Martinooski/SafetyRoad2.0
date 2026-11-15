import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
const CARTO_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const CARTO_ATTR = "&copy; OpenStreetMap contributors &copy; CARTO";
const SENSITIVITY_MS2: Record<string, number> = { Alta: 20, Media: 30, Baja: 40 };

type Severity = "LEVE" | "MODERADA" | "GRAVE";
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
};

type AlertRecord = {
  id: number;
  title: string;
  status: IncidentStatus;
  date: string;
  reason: string;
};

const INITIAL_INCIDENTS: Incident[] = [
  {
    id: "INC-2025-0087",
    place: "Ruta 5 con Av. Videla",
    severity: "MODERADA",
    status: "ALERTA_OPERADOR",
    time: "hace 1 hora",
    date: "19 jun 2025 · 14:32",
    camera: "CAM-CQBO-04",
    origin: "CAMARA",
    vehicles: 2,
    heavy: true,
    blockage: "Parcial (1 pista)",
    lat: -29.9712,
    lng: -71.3378,
    pin: { left: "56%", top: "54%" },
  },
  {
    id: "INC-2025-0086",
    place: "Av. Costanera",
    severity: "LEVE",
    status: "CERRADO_ATENDIDO",
    time: "hace 5 horas",
    date: "19 jun 2025 · 10:08",
    camera: "CAM-CQBO-11",
    origin: "CAMARA",
    vehicles: 1,
    heavy: false,
    blockage: "Sin bloqueo",
    lat: -29.9465,
    lng: -71.3462,
    pin: { left: "27%", top: "35%" },
  },
  {
    id: "INC-2025-0081",
    place: "Aguirre con Larraín",
    severity: "GRAVE",
    status: "DERIVADO",
    time: "ayer",
    date: "18 jun 2025 · 18:47",
    camera: "CAM-LS-07",
    origin: "CAMARA",
    vehicles: 4,
    heavy: true,
    blockage: "Total o mayoritario",
    lat: -29.9078,
    lng: -71.2521,
    pin: { left: "72%", top: "26%" },
  },
];

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
}: {
  incidents: Incident[];
  radius: number;
  onIncident: (i: Incident) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const incidentLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const zoneCircleRef = useRef<L.Circle | null>(null);
  const onIncidentRef = useRef(onIncident);
  const [userLocation, setUserLocation] = useState<L.LatLngExpression>([-29.9533, -71.3395]);
  const [locationState, setLocationState] = useState<"buscando" | "gps" | "referencia">("buscando");
  const [mapProviderReady, setMapProviderReady] = useState(true);

  onIncidentRef.current = onIncident;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [-29.9533, -71.3395],
      zoom: 12,
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
      L.tileLayer(CARTO_DARK, { attribution: CARTO_ATTR, maxZoom: 19, subdomains: "abcd" }).addTo(map);
    }
    L.control.zoom({ position: "bottomright" }).addTo(map);

    const userIcon = L.divIcon({
      className: "live-user-marker",
      html: '<span class="live-user-pulse"></span><span class="live-user-core"></span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    userMarkerRef.current = L.marker([-29.9533, -71.3395], {
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
    zoneCircleRef.current = L.circle([-29.9533, -71.3395], {
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
    let firstFix = true;
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const location: L.LatLngExpression = [coords.latitude, coords.longitude];
        setUserLocation(location);
        setLocationState("gps");
        userMarkerRef.current?.setLatLng(location);
        zoneCircleRef.current?.setLatLng(location);
        if (firstFix) {
          mapRef.current?.flyTo(location, 14, { duration: 1.2 });
          firstFix = false;
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
    incidents.forEach((incident) => {
      const color =
        incident.severity === "GRAVE"
          ? "#e53935"
          : incident.severity === "MODERADA"
            ? "#f59e0b"
            : "#facc15";
      const icon = L.divIcon({
        className: "live-incident-marker",
        html: `<span style="--pin-color:${color}"><b>!</b></span>`,
        iconSize: [38, 44],
        iconAnchor: [19, 42],
      });
      L.marker([incident.lat, incident.lng], {
        icon,
        title: `Incidente: ${incident.place}`,
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
  openMidSignal,
}: {
  incidents: Incident[];
  onIncident: (i: Incident) => void;
  openMidSignal: number;
}) {
  const positions = [116, 390, Math.round(Math.min(window.innerHeight, 932) * 0.86)];
  const [height, setHeight] = useState(positions[0]);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ y: 0, height: 0 });

  useEffect(() => {
    if (openMidSignal > 0) setHeight(positions[1]);
  }, [openMidSignal]);

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
          <h2>Historial de incidentes cercanos</h2>
          <span>{incidents.length} cercanos</span>
        </div>
      </div>
      <div className="incident-list">
        {incidents.map((incident) => (
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
          <Icon name="warning" size={18} /> ALERTA DE IMPACTO DETECTADA
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
          <p className="assist-copy">Se enviará asistencia automática</p>
          <button className="btn btn-green" onClick={() => resolve(false)}>
            <Icon name="check" /> SÍ, ESTOY BIEN <span>(Cancelar)</span>
          </button>
          <button className="btn btn-red" onClick={() => resolve(true)}>
            <Icon name="phone" /> NECESITO AYUDA
          </button>
          <p className="impact-foot">
            Llamando a servicios de emergencia en <strong>{seconds}s</strong> si no hay respuesta…
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
  const notify =
    incident.severity === "LEVE"
      ? "Carabineros"
      : incident.severity === "MODERADA"
        ? "Carabineros y SAMU"
        : "SAMU, Bomberos y Carabineros";
  const next =
    currentIndex >= 0 && currentIndex < LIFECYCLE.length - 1 ? LIFECYCLE[currentIndex + 1] : null;
  const json = {
    id_incidente: incident.id,
    timestamp_deteccion: "2025-06-19T14:32:08-04:00",
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
    evidencia: {
      url_fotograma_anonimizado: "/evidencia/fotograma-087.jpg",
      url_clip_pre_post: "/evidencia/clip-087.mp4",
    },
    estado_gestion: incident.status,
  };
  const rows = [
    ["Fecha y hora", incident.date],
    ["Cámara / origen", incident.camera],
    ["Vehículos", String(incident.vehicles)],
    ["Pesados", incident.heavy ? "Sí" : "No"],
    ["Bloqueo", incident.blockage],
    ["Evidencia", "Fotograma anonimizado"],
    ["Se notifica a", notify],
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
          {next && (
            <button className="btn btn-red action-btn" onClick={() => onUpdate(next)}>
              Avanzar a {next}
              <small>Demo operador</small>
            </button>
          )}
          {incident.status === "EN_REVISION" && (
            <button className="btn btn-ghost" onClick={() => onUpdate("CERRADO_FALSA_ALARMA")}>
              Descartar (falsa alarma)
            </button>
          )}
        </section>
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
      L.tileLayer(CARTO_DARK, { attribution: CARTO_ATTR, maxZoom: 19, subdomains: "abcd" }).addTo(map);
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
      const fallbackLabel = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
      onSelectRef.current({ lat: latlng.lat, lng: latlng.lng, label: fallbackLabel });
      if (!mapTilerKey) return;

      const requestId = ++requestRef.current;
      setSearchingAddress(true);
      try {
        const response = await fetch(
          `https://api.maptiler.com/geocoding/${latlng.lng},${latlng.lat}.json?key=${encodeURIComponent(mapTilerKey)}&language=es&limit=1`,
        );
        if (!response.ok) throw new Error("No se pudo obtener la dirección");
        const data = (await response.json()) as {
          features?: Array<{ place_name?: string; text?: string }>;
        };
        if (requestId !== requestRef.current) return;
        const label = data.features?.[0]?.place_name || data.features?.[0]?.text || fallbackLabel;
        onSelectRef.current({ lat: latlng.lat, lng: latlng.lng, label });
      } catch {
        // Las coordenadas siguen siendo válidas aunque no se pueda resolver una dirección.
      } finally {
        if (requestId === requestRef.current) setSearchingAddress(false);
      }
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
  onSubmit: (incident: Incident) => void;
}) {
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null);
  const [vehicles, setVehicles] = useState(1);
  const [heavy, setHeavy] = useState(false);
  const [blockage, setBlockage] = useState("Sin bloqueo");
  const severity: Severity =
    blockage === "Total o mayoritario" || (vehicles >= 3 && heavy)
      ? "GRAVE"
      : vehicles >= 3 || heavy || blockage.startsWith("Parcial")
        ? "MODERADA"
        : "LEVE";
  const notify =
    severity === "LEVE"
      ? "Carabineros"
      : severity === "MODERADA"
        ? "Carabineros y SAMU"
        : "SAMU, Bomberos y Carabineros";
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLocation) return;
    onSubmit({
      id: `INC-2025-${String(Date.now()).slice(-4)}`,
      place: selectedLocation.label,
      severity,
      status: "ALERTA_OPERADOR",
      time: "ahora",
      date: "Ahora",
      camera: "APP-CIUDADANO",
      origin: "APP_CIUDADANO",
      vehicles,
      heavy,
      blockage,
      lat: selectedLocation.lat,
      lng: selectedLocation.lng,
      pin: { left: "43%", top: "44%" },
    });
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
        <div className={`selected-place ${selectedLocation ? "ready" : ""}`}>
          <Icon name={selectedLocation ? "check" : "pin"} size={17} />
          <div>
            <span>{selectedLocation ? "PUNTO SELECCIONADO" : "FALTA SELECCIONAR EL PUNTO"}</span>
            <strong>{selectedLocation?.label || "Toca una calle o intersección en el mapa"}</strong>
          </div>
        </div>
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
          <p>GRAVEDAD ESTIMADA</p>
          <div>
            <Chip tone={severity}>{severity}</Chip>
            <span>Según los datos ingresados</span>
          </div>
          <hr />
          <p>Se notificará a</p>
          <strong>{notify}</strong>
        </div>
        <button className="btn btn-red submit-btn" type="submit" disabled={!selectedLocation}>
          <Icon name="alert" /> Enviar reporte
        </button>
      </form>
    </div>
  );
}

function AlertsScreen({ records, onBack }: { records: AlertRecord[]; onBack: () => void }) {
  return (
    <div className="screen scroll-screen">
      <Header
        title="Historial de alertas"
        subtitle="Alertas detectadas por tu dispositivo"
        onBack={onBack}
      />
      <main className="screen-content">
        {records.length === 0 ? (
          <div className="empty-state">
            <Icon name="shield" size={36} />
            <h2>Sin alertas registradas</h2>
            <p>Tus alertas de impacto aparecerán aquí.</p>
          </div>
        ) : (
          <div className="alert-history">
            {records.map((r) => (
              <article className="history-card" key={r.id}>
                <div className="history-icon">
                  <Icon name={r.status === "CERRADO_FALSA_ALARMA" ? "check" : "phone"} />
                </div>
                <div>
                  <h3>{r.title}</h3>
                  <Chip tone={r.status === "CERRADO_FALSA_ALARMA" ? "green" : "gray"}>
                    {r.status}
                  </Chip>
                  <p>
                    {r.date} · {r.reason}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
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

function MetricsScreen({ onBack, incidents }: { onBack: () => void; incidents: Incident[] }) {
  const metrics = [
    ["Tasa de falsas alarmas", "8,2%", "≤ 15%", true],
    ["Completitud de la ficha", "100%", "100%", true],
    ["Tiempo total de detección", "3,8 s", "≤ 5 s", true],
    ["Tiempo de notificación", "3,4 s", "≤ 3 s", false],
  ] as const;
  return (
    <div className="screen scroll-screen">
      <Header title="Indicadores" subtitle="Rendimiento de SafetyRoad" onBack={onBack} />
      <main className="screen-content">
        <div className="metric-summary">
          <p>INCIDENTES MONITOREADOS</p>
          <strong>{incidents.length}</strong>
          <span>en tu zona durante los últimos 7 días</span>
        </div>
        <div className="metrics-grid">
          {metrics.map(([name, value, goal, ok]) => (
            <article className="metric-card" key={name}>
              <div>
                <span>{name}</span>
                <Chip tone={ok ? "green" : "red"}>{ok ? "CUMPLE" : "NO CUMPLE"}</Chip>
              </div>
              <strong>{value}</strong>
              <p>Meta {goal}</p>
              <i className={ok ? "ok" : "bad"} />
            </article>
          ))}
        </div>
        <p className="metrics-note">
          Los indicadores se calculan sobre los incidentes procesados durante los últimos 30 días.
          Última actualización: hoy, 14:40.
        </p>
      </main>
    </div>
  );
}

function SettingsScreen({
  settings,
  onBack,
  onSave,
  onRevoke,
}: {
  settings: { contact: string; emergency: string; sensitivity: string };
  onBack: () => void;
  onSave: (s: { contact: string; emergency: string; sensitivity: string }) => void;
  onRevoke: () => void;
}) {
  const [form, setForm] = useState(settings);
  return (
    <div className="screen scroll-screen">
      <Header title="Configuración" subtitle="Cobertura y detección de impactos" onBack={onBack} />
      <main className="screen-content form-content settings-form">
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
  const [incidents, setIncidents] = useState<Incident[]>(() => load("sr_incidents", INITIAL_INCIDENTS));
  const [selectedId, setSelectedId] = useState(INITIAL_INCIDENTS[0].id);
  const [impactOpen, setImpactOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consent, setConsent] = useState<boolean>(() => load("sr_consent", true));
  const [radius, setRadius] = useState<number>(() => load("sr_radius", 1.5));
  const [openMidSignal, setOpenMidSignal] = useState(0);
  const [toast, setToast] = useState("");
  const [alerts, setAlerts] = useState<AlertRecord[]>(() => load("sr_alerts", []));
  const [settings, setSettings] = useState(() =>
    load("sr_settings", { contact: "", emergency: "131 – SAMU", sensitivity: "Media" }),
  );
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
    let last = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || impactOpenRef.current) return;
      const g = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
      const now = Date.now();
      if (g > limit && now - last > 10000) {
        last = now;
        setImpactOpen(true);
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
  const resolveImpact = (needHelp: boolean) => {
    setImpactOpen(false);
    const now = new Date().toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
    if (needHelp) {
      setAlerts((a) => [
        {
          id: Date.now(),
          title: "Asistencia solicitada",
          status: "ALERTA_OPERADOR",
          date: now,
          reason: "Impacto detectado",
        },
        ...a,
      ]);
      const impact: Incident = {
        id: `IMP-${Date.now()}`,
        place: "Ubicación actual",
        severity: "GRAVE",
        status: "ALERTA_OPERADOR",
        time: "ahora",
        date: now,
        camera: "APP-IMPACTO",
        origin: "APP_IMPACTO",
        vehicles: 1,
        heavy: false,
        blockage: "Por verificar",
        lat: lastPos.current?.lat ?? -29.953,
        lng: lastPos.current?.lng ?? -71.338,
        pin: { left: "48%", top: "50%" },
      };
      setIncidents((items) => [impact, ...items]);
      const number = settings.emergency.slice(0, 3);
      setToast(`Asistencia solicitada. Abriendo llamada al ${number}.`);
      window.setTimeout(() => {
        window.location.href = `tel:${number}`;
      }, 300);
    } else {
      setAlerts((a) => [
        {
          id: Date.now(),
          title: "Cancelada – estoy bien",
          status: "CERRADO_FALSA_ALARMA",
          date: now,
          reason: "Cancelada por el usuario",
        },
        ...a,
      ]);
      setToast("Alerta cancelada y registrada como falsa alarma.");
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
          onSubmit={(incident) => {
            setIncidents((items) => [incident, ...items]);
            setOpenMidSignal(Date.now());
            setScreen("map");
            setToast("Reporte enviado y agregado al mapa.");
          }}
        />
      );
    if (screen === "alerts")
      return <AlertsScreen records={alerts} onBack={() => setScreen("map")} />;
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
      return <MetricsScreen incidents={incidents} onBack={() => setScreen("map")} />;
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
          onRevoke={() => {
            setConsentOpen(true);
            setConsent(false);
            setToast("Consentimiento revocado.");
          }}
        />
      );
    return null;
  }, [screen, selected, alerts, radius, incidents, settings]);

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
                  <i /> {consent ? "Activa en segundo plano" : "Protección desactivada"}
                </p>
              </div>
              <div className="shield-status">
                <Icon name="shield" size={19} />
              </div>
            </header>
            <div className="map-wrap">
              <MapArtwork incidents={incidents} radius={radius} onIncident={openIncident} />
              <button className="simulate-btn" onClick={() => setImpactOpen(true)}>
                <Icon name="bolt" size={15} /> Simular impacto
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
              openMidSignal={openMidSignal}
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
