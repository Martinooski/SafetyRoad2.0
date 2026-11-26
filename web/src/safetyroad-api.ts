export type ApiMetric = {
  name?: string;
  nombre?: string;
  value: string;
  target?: string;
  meta?: string;
  note?: string;
  measured: boolean;
};
export type ReportResponse = {
  ok: boolean;
  id: string;
  token: string;
  estado?: "ALERTA_OPERADOR";
  sugerencia?: string;
  prioridad?: string;
};
export type TrackingMovement = {
  fecha: string;
  accion: string;
  estado?: string;
  servicios?: string[];
};

export type TrackingResponse = {
  id: string;
  estado: "DETECTADO" | "EN_VERIFICACION" | "ALERTA_OPERADOR" | "EN_REVISION" | "DERIVADO" | "DERIVADO_SIMULADO" | "CERRADO_ATENDIDO" | "CERRADO_FALSA_ALARMA";
  prioridad: string;
  archivado?: boolean;
  sugerencia?: string;
  servicios?: string[];
  movimientos?: TrackingMovement[];
  derivacion_simulada?: boolean;
  despacho_real?: boolean;
};

declare global {
  interface Window {
    SafetyRoadBridge?: {
      request: (id: string, method: string, route: string, payload: string, serverUrl: string) => void;
    };
  }
}

let counter = 0;

export async function requestSafetyRoad<T>(
  route: string, method = "GET", payload?: Record<string, unknown>, serverUrl = "",
): Promise<T> {
  if (!route.startsWith("/api/")) throw new Error("Ruta no permitida");
  if (window.SafetyRoadBridge) {
    if (!serverUrl.trim()) throw new Error("Configura la dirección del servidor en Ajustes");
    const id = `sr-${Date.now()}-${++counter}`;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("safetyroad-response", listener);
      };
      const listener = (event: Event) => {
        const data = (event as CustomEvent<{ id: string; code: number; body: string }>).detail;
        if (!data || data.id !== id) return;
        cleanup();
        try {
          const parsed = JSON.parse(data.body);
          if (data.code < 200 || data.code >= 300) throw new Error(parsed.error || `HTTP ${data.code}`);
          resolve(parsed as T);
        } catch (e) { reject(e); }
      };
      const timer = window.setTimeout(() => {
        cleanup(); reject(new Error("Sin respuesta del servidor. Revisa IP y Wi-Fi."));
      }, 18000);
      window.addEventListener("safetyroad-response", listener);
      try { window.SafetyRoadBridge!.request(id, method, route, JSON.stringify(payload || {}), serverUrl.trim()); }
      catch (e) { cleanup(); reject(e); }
    });
  }
  // Navegador: usa el mismo origen. En desarrollo, Vite hace proxy /api hacia Python.
  const response = await fetch(route, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(payload || {}) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Error HTTP ${response.status}`);
  return result as T;
}
