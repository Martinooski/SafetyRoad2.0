"""SafetyRoad 2.0 | Prototipo local UOCT.

Ejecutar en Windows: py servidor.py
Solo biblioteca estandar de Python. NO conecta a cámaras, SAMU ni servicios reales.
Los reportes de la app y los incidentes de cámara se SIMULAN.
"""
from __future__ import annotations

import copy
import csv
import io
import base64
import json
import os
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import urlparse
import webbrowser
import secrets
import shutil
import re
import math
import time
import unicodedata
from urllib.parse import parse_qs, unquote
from analisis_video import analizar_video

ROOT = Path(__file__).resolve().parent
# El historial queda fuera de la carpeta del ZIP para sobrevivir actualizaciones.
# SAFETYROAD_DATA_DIR permite elegir una ruta explícita y ejecutar pruebas aisladas.
def carpeta_de_datos():
    especificada = os.environ.get('SAFETYROAD_DATA_DIR')
    if especificada:
        return Path(especificada).expanduser().resolve()
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA')
        base = Path(base) if base else Path.home() / 'AppData' / 'Local'
        return (base / 'SafetyRoad2' / 'datos').resolve()
    return (Path.home() / '.local' / 'share' / 'SafetyRoad2' / 'datos').resolve()

DATA_DIR = carpeta_de_datos()
DB_FILE = DATA_DIR / 'eventos.json'
LEGACY_DB_FILE = ROOT / 'data' / 'eventos.json'

INDICATORS = json.loads((ROOT / 'indicadores.json').read_text(encoding='utf-8'))
LOCK = RLock()
PORT = int(os.environ.get('PORT') or os.environ.get('SAFETYROAD_PORT', 8765))
PUBLIC_MODE = os.environ.get('SAFETYROAD_PUBLIC') == '1' or bool(os.environ.get('RENDER'))
DEMO_PASSWORD = os.environ.get('SAFETYROAD_DEMO_PASSWORD', '')
HOST = '0.0.0.0' if PUBLIC_MODE or os.environ.get('SAFETYROAD_LAN') == '1' else '127.0.0.1'
if PUBLIC_MODE and len(DEMO_PASSWORD) < 12:
    raise RuntimeError('Modo público bloqueado: define SAFETYROAD_DEMO_PASSWORD con 12 caracteres o más.')
STATUS = {'ALERTA_OPERADOR', 'EN_REVISION', 'DERIVADO_SIMULADO',
          'CERRADO_FALSA_ALARMA', 'CERRADO_ATENDIDO'}
SERVICES = {'SAMU 131', 'Bomberos 132', 'Carabineros 133'}
TYPES = {'Vuelco', 'Colisión múltiple', 'Colisión', 'Contacto leve',
         'Movimiento sospechoso', 'Otro'}


def now_dt():
    return datetime.now().astimezone()


def stamp(dt=None):
    return (dt or now_dt()).isoformat(timespec='seconds')


def clean(value, max_len=220):
    return str(value or '').strip()[:max_len]


def priority(tipo, vehiculos, bloqueo, ninos, visibilidad):
    """Reglas preliminares de simulación, NO un detector automático de accidentes.

    Una condición de niños 'confirmada' significa solo que el operador
    marcó esa opción para la prueba: no hay detección infantil automática.
    """
    if visibilidad == 'Baja' and vehiculos == 0 and tipo in ('Otro', 'Movimiento sospechoso'):
        return 'IND', 'Visibilidad insuficiente: operador debe verificar'
    if tipo == 'Vuelco':
        return 'P1', 'Regla demostrativa: vuelco'
    if tipo == 'Colisión múltiple' or vehiculos >= 3:
        return 'P1', 'Regla demostrativa: colisión múltiple o 3+ vehículos'
    if ninos in ('confirmada', 'indicios_por_verificar'):
        return 'P1', 'Posible presencia de niños declarada manualmente (SIN verificar): revisión prioritaria'
    if tipo == 'Colisión' or (vehiculos >= 2 and bloqueo == 'Parcial') or bloqueo == 'Total':
        return 'P2', 'Regla demostrativa: colisión / bloqueo de vía'
    if tipo == 'Contacto leve' and bloqueo == 'No':
        return 'P3', 'Regla demostrativa: contacto leve sin bloqueo'
    return 'IND', 'Evidencia insuficiente para clasificar'


def make_seed():
    # Datos ficticios basados en los cinco ejemplos del wireframe aportado.
    base = now_dt()
    rows = [
        ('P1', 'Vuelco', 'Av. Costanera / Larraín Alcalde', 'CAM-CQBO-04', 3,
         ['Cambio brusco de trayectoria', 'Inmovilidad posterior', 'Humo visible'],
         'indicios_por_verificar', 'Vuelco: posible gravedad alta, revisar indicios de niños', 24, 45, 45),
        ('P1', 'Colisión múltiple', 'Av. Cuatro Esquinas / Ruta 5', 'CAM-LSER-12', 4,
         ['Bloqueo total de vía', 'Inmovilidad posterior'],
         'no_determinada', '3+ vehículos y bloqueo total (demostración)', 63, 22, 140),
        ('P2', 'Colisión', 'Av. Francisco de Aguirre / Balmaceda', 'CAM-LSER-07', 2,
         ['Bloqueo parcial de pista'], 'no_determinada',
         'Dos vehículos y bloqueo parcial (demostración)', 44, 34, 215),
        ('IND', 'Movimiento sospechoso', 'Av. Costanera / Pedro Pablo Muñoz', 'CAM-CQBO-02', 0,
         ['Visibilidad reducida'], 'no_determinada',
         'No es posible confirmar un accidente', 22.5, 80, 285),
        ('P3', 'Contacto leve', 'Av. Videla / Pan de Azúcar', 'CAM-CQBO-11', 1,
         ['Vehículo orillado, sin bloqueo'], 'no_determinada',
         'Contacto leve sin bloqueo (demostración)', 46, 62, 360),
    ]
    events = []
    for i, (p, tipo, ubic, cam, veh, senales, ninos, razon, x, y, ago) in enumerate(rows, 1):
        events.append({
            'id': f'EVT-{i:03d}', 'source': 'CAMARA', 'tipo': tipo,
            'p': p, 'ubicacion': ubic, 'camara': cam, 'vehiculos': veh,
            'ninos': ninos, 'bloqueo': 'No determinado', 'visibilidad': 'Normal',
            'senales': senales, 'razon': razon,
            'st': 'EN_REVISION' if i in (2, 4) else 'ALERTA_OPERADOR',
            'created_at': stamp(base - timedelta(seconds=ago)),
            'evidencia': 'media/demo_accidente.mp4' if i == 1 else '',
            'evidencia_tipo': 'video_sintetico' if i == 1 else 'sin_clip',
            'reportes_app': [], 'servicios': [], 'historial': [],
            'visible_at': None, 'latency_s': None, 'seed': True,
            'x': x, 'y': y,
        })
    return {'next_id': 6, 'events': events, 'created': stamp(),
            'estadisticas': {'alertas_historicas': 0, 'origen': 'contador_nuevo'}}


def inicializar_contador(db):
    """Recupera el contador en datos antiguos sin alterar eventos ni IDs."""
    # Los ejemplos EVT-001 a EVT-005 no representan accidentes recibidos.
    minimo = max(0, db.get('next_id', 6) - 6)
    minimo = max(minimo, sum(not e.get('seed') for e in db.get('events', [])))
    estadisticas = db.setdefault('estadisticas', {})
    try:
        previo = int(estadisticas.get('alertas_historicas', 0))
    except (ValueError, TypeError):
        previo = 0
    estadisticas['alertas_historicas'] = max(previo, minimo)
    estadisticas.setdefault('origen', 'reconstruido_desde_ids_existentes')
    return db


def contabilizar_nueva_alerta(db):
    previo = int(db.get('estadisticas', {}).get('alertas_historicas', 0))
    inicializar_contador(db)
    db['estadisticas']['alertas_historicas'] = max(previo + 1, db['estadisticas']['alertas_historicas'])


def persist(db):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    target = DB_FILE.with_suffix('.tmp')
    target.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding='utf-8')
    target.replace(DB_FILE)


def load_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Si existe la versión anterior junto al código, importarla una sola vez.
    # Jamás reemplazar la base persistente si ya existe.
    if not DB_FILE.exists() and LEGACY_DB_FILE.is_file() and LEGACY_DB_FILE.resolve() != DB_FILE:
        try:
            antiguo = json.loads(LEGACY_DB_FILE.read_text(encoding='utf-8'))
            if not isinstance(antiguo.get('events'), list):
                raise ValueError('Historial antiguo sin lista de eventos')
            shutil.copy2(LEGACY_DB_FILE, DB_FILE)
            print('Historial anterior conservado en la carpeta persistente.')
        except (ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError('El historial antiguo no se pudo importar; no se borró.') from exc
    if not DB_FILE.exists():
        db = make_seed()
        persist(db)
        return db
    try:
        db = json.loads(DB_FILE.read_text(encoding='utf-8'))
        assert isinstance(db['events'], list) and isinstance(db['next_id'], int)
        if 'estadisticas' not in db:
            inicializar_contador(db)
            persist(db)
        else:
            anterior = db['estadisticas'].get('alertas_historicas')
            inicializar_contador(db)
            if db['estadisticas']['alertas_historicas'] != anterior:
                persist(db)
        return db
    except Exception as exc:
        raise RuntimeError('Error al leer el historial persistente. No se eliminó nada: ' + str(DB_FILE)) from exc

DB = load_db()


def find_event(db, eid):
    return next((e for e in db['events'] if e['id'] == eid), None)


def create_event(payload, source='CAMARA'):
    tipo = clean(payload.get('tipo'), 60)
    ubicacion = clean(payload.get('ubicacion'))
    if not ubicacion:
        raise ValueError('Debes ingresar una ubicación.')
    if source == 'CAMARA' and tipo not in TYPES:
        raise ValueError('Selecciona un tipo de evento válido.')
    try:
        veh = int(payload.get('vehiculos', 0))
    except (TypeError, ValueError):
        raise ValueError('Cantidad de vehículos inválida.')
    if veh < 0 or veh > 30:
        raise ValueError('Indica entre 0 y 30 vehículos (0 = no determinado).')
    bloqueo = clean(payload.get('bloqueo', 'No determinado'), 50)
    ninos = clean(payload.get('ninos', 'no_determinada'), 40)
    visibilidad = clean(payload.get('visibilidad', 'Normal'), 30)
    descripcion = clean(payload.get('descripcion'), 500)
    lat, lng = None, None
    if payload.get('lat') not in (None, '') and payload.get('lng') not in (None, ''):
        try:
            lat, lng = float(payload['lat']), float(payload['lng'])
        except (TypeError, ValueError):
            raise ValueError('Coordenadas inválidas.')
        if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError('Coordenadas fuera de rango.')
    if bloqueo not in ('No', 'Parcial', 'Total', 'No determinado'):
        raise ValueError('Bloqueo inválido.')
    if ninos not in ('confirmada', 'indicios_por_verificar', 'no_determinada', 'sin_indicios'):
        raise ValueError('Valor inválido para niños.')
    if visibilidad not in ('Normal', 'Baja'):
        raise ValueError('Visibilidad inválida.')
    origen = clean(payload.get('origen', 'app_manual'), 35) if source == 'APP' else 'CAMARA'
    if source == 'APP':
        # Un reporte ciudadano NO es una detección verificada: la etiqueta P1/P2/P3
        # indica solo prioridad de REVISIÓN basada en lo declarado por el testigo.
        if origen in ('app_sensor', 'app_sensor_cancelado'):
            p, razon = 'IND', 'Impacto de sensor experimental sin verificación'
            tipo = 'Movimiento sospechoso'
        else:
            if tipo not in TYPES:
                tipo = 'Otro'
            p, razon = priority(tipo, veh, bloqueo, ninos, visibilidad)
            razon += '. Reportado por ciudadano; NO confirmado'
        sugerencia = p
    else:
        p, razon = priority(tipo, veh, bloqueo, ninos, visibilidad)
        sugerencia = p
    return {
        'source': source, 'origen': origen, 'sugerencia_prioridad': sugerencia,
        'tipo': tipo, 'clasificacion_verificada': False,
        'requiere_asistencia': origen == 'app_sensor' if source == 'APP' else False,
        'evaluacion_operador': None,
        'rol_reportante': clean(payload.get('rol_reportante', 'no_determinado'), 30),
        'p': p, 'ubicacion': ubicacion, 'lat': lat, 'lng': lng,
        'camara': clean(payload.get('camara'), 60) if source == 'CAMARA' else '',
        'vehiculos': veh, 'ninos': ninos, 'ninos_fuente': 'declaracion_ciudadano' if source == 'APP' else 'simulacion_camara',
        'bloqueo': bloqueo, 'visibilidad': visibilidad,
        'senales': [descripcion] if descripcion else [],
        'razon': razon, 'st': 'ALERTA_OPERADOR', 'created_at': stamp(),
        'evidencia': 'media/demo_accidente.mp4' if source == 'CAMARA' else '',
        'evidencia_tipo': 'video_sintetico' if source == 'CAMARA' else 'sin_clip',
        'reportes_app': [], 'servicios': [], 'historial': [],
        'coincidencias': [], 'tracking_tokens': [],
        'visible_at': None, 'latency_s': None,
        'recibido_servidor': stamp(), 'procesamiento_servidor_ms': None,
        'seed': False,
        'x': 48, 'y': 48,
    }



def distancia_km(lat1, lng1, lat2, lng2):
    """Distancia aproximada entre posiciones GPS (Haversine)."""
    r = 6371.0
    a1, a2 = math.radians(lat1), math.radians(lat2)
    da, dl = math.radians(lat2-lat1), math.radians(lng2-lng1)
    h = math.sin(da/2)**2 + math.cos(a1)*math.cos(a2)*math.sin(dl/2)**2
    return 2*r*math.asin(min(1., math.sqrt(h)))


def palabras_lugar(texto):
    texto = unicodedata.normalize('NFKD', texto.lower())
    texto = ''.join(c for c in texto if not unicodedata.combining(c))
    palabras = set(re.findall(r'[a-z0-9]{3,}', texto))
    return palabras - {'avenida', 'calle', 'sector', 'region', 'coquimbo', 'serena', 'ruta', 'entre'}


def posibles_coincidencias(db, reporte):
    """Sugiere, pero NUNCA fusiona, casos de distintas fuentes.

    Tiempo máximo: 10 minutos, distancia GPS máxima: 700 metros.
    Si no hay GPS en ambos, exige al menos dos palabras específicas iguales.
    """
    candidatos = []
    try:
        fecha = datetime.fromisoformat(reporte['created_at'])
    except (ValueError, KeyError):
        return []
    for caso in db['events']:
        # Los ejemplos iniciales jamás son evidencia de cámaras reales ni candidatos a vinculación.
        if caso.get('seed'):
            continue
        if caso.get('id') == reporte.get('id') or caso.get('st', '').startswith('CERRADO'):
            continue
        if (caso.get('source') == 'APP') == (reporte.get('source') == 'APP'):
            continue
        if caso.get('source') not in ('APP', 'CAMARA') or reporte.get('source') not in ('APP', 'CAMARA'):
            continue
        try:
            segundos = abs((fecha - datetime.fromisoformat(caso['created_at'])).total_seconds())
        except (ValueError, KeyError):
            continue
        if segundos > 600:
            continue
        a, b = (reporte.get('lat'), reporte.get('lng')), (caso.get('lat'), caso.get('lng'))
        if all(x is not None for x in a+b):
            km = distancia_km(a[0], a[1], b[0], b[1])
            if km <= .7:
                candidatos.append({'id': caso['id'], 'motivo':f'GPS cercano ({round(km*1000)} m) y diferencia temporal {round(segundos)} s'})
        else:
            p1,p2=palabras_lugar(reporte.get('ubicacion','')),palabras_lugar(caso.get('ubicacion',''))
            if len(p1 & p2) >= 2:
                candidatos.append({'id': caso['id'], 'motivo':'Ubicación textual compatible; verificar manualmente'})
    return candidatos[:5]


def buscar_por_token(db, token):
    for e in db['events']:
        if token and token in e.get('tracking_tokens', []):
            return e
    return None


def enlazar_dos_fuentes(db, id_app, id_camara):
    """Fusiona solo con confirmación explícita del operador."""
    app = find_event(db, id_app)
    cam = find_event(db, id_camara)
    if not app or not cam or app is cam:
        raise ValueError('Se requieren dos incidentes distintos y existentes.')
    if app.get('seed') or cam.get('seed'):
        raise ValueError('Los ejemplos ficticios no se pueden vincular a reportes nuevos.')
    if app.get('source') != 'APP' or not str(cam.get('source', '')).startswith('CAMARA'):
        raise ValueError('Solo se puede unir un reporte de app con un incidente de cámara.')
    if app['st'].startswith('CERRADO') or cam['st'].startswith('CERRADO'):
        raise ValueError('No se pueden vincular casos cerrados.')
    cam['source'] = 'CAMARA + APP'
    cam.setdefault('reportes_app', []).extend(app.get('reportes_app', []))
    # Conservar las alertas de sensores vinculadas para no cambiar los
    # denominadores históricos al unir expedientes.
    cam.setdefault('origenes_vinculados', []).append({
        'origen': app.get('origen'), 'id': app.get('id'),
        'descartada': app.get('st') == 'CERRADO_FALSA_ALARMA'})
    cam.setdefault('origenes_vinculados', []).extend(app.get('origenes_vinculados', []))
    if app.get('ninos') in ('indicios_por_verificar', 'confirmada'):
        cam['ninos'] = 'indicios_por_verificar'  # No confirma menores en imágenes
    if app.get('p') == 'P1' and cam.get('p') != 'P1':
        cam['p'] = 'P1'
        cam['razon'] = 'Revisión P1 por declaración ciudadana vinculada, SIN verificar'
    cam.setdefault('tracking_tokens', []).extend(app.get('tracking_tokens', []))
    cam.setdefault('historial', []).append({'fecha':stamp(), 'accion':'vinculacion_confirmada',
                                             'origen':app['id'], 'destino':cam['id']})
    db['events'].remove(app)
    return cam


def metrics(db):
    """Seis indicadores del Excel, sin confundir mediciones DEMO con un detector real.

    Tiempo de notificación original: choque detectado por algoritmo → aviso en
    dashboard. Sin detector conectado no puede calcularse de forma válida.
    El tiempo registro→primera visualización se muestra APARTE.
    """
    events = [e for e in db['events'] if not e.get('seed')]
    total = len(events)
    completed = sum(bool(e.get('ubicacion') and e.get('created_at')
                     and e.get('evidencia') and e.get('vehiculos', 0) > 0
                     and e.get('p') != 'IND') for e in events)
    # Los descartes de sensores se miden sobre SOLO alertas experimentales.
    # Un reporte ciudadano/testigo NO contamina esta tasa demostrativa.
    sensores = [
        {'descartada': e.get('st') == 'CERRADO_FALSA_ALARMA'}
        for e in events if e.get('origen') in ('app_sensor', 'app_sensor_cancelado')
    ]
    sensores.extend(
        vinculado for e in events for vinculado in e.get('origenes_vinculados', [])
        if vinculado.get('origen') in ('app_sensor', 'app_sensor_cancelado')
    )
    sensor_descartadas = sum(bool(s.get('descartada')) for s in sensores)
    porcent_sensor = 100 * sensor_descartadas / len(sensores) if sensores else None
    pct_full = 100 * completed / total if total else None
    values = [
        {'value': '—', 'note': 'Sin medición válida: requiere impacto detectado por algoritmo y aviso visible en dashboard. El tiempo hasta primera visualización se informa aparte.', 'measured': False},
        {'value': f'{pct_full:.1f} %' if pct_full is not None else '—',
         'note': (f'{completed}/{total} con ubicación, hora, VIDEO, vehículos conocidos y prioridad definida. '
                  'Las alertas del celular sin cámara no cumplen esta exigencia original; '
                  'la integridad mínima por fuente aparece aparte.') if total else 'Sin incidentes nuevos; ejemplos excluidos', 'measured': bool(total)},
        {'value': '—', 'note': 'Requiere verdaderos y falsos positivos validados mediante video', 'measured': False},
        {'value': f'{porcent_sensor:.1f} %' if porcent_sensor is not None else '—',
         'note': (f'{sensor_descartadas}/{len(sensores)} descartes de alertas de sensor (DEMO). No incluye reportes ciudadanos; NO es tasa oficial de notificaciones erróneas al operador.') if sensores else 'Sin alertas de sensor registradas; reportes ciudadanos excluidos',
         'measured': bool(sensores)},
        {'value': '—', 'note': 'Necesita etiqueta de referencia INDEPENDIENTE. La evaluación del operador se muestra aparte y no equivale a precisión validada.', 'measured': False},
        {'value': '—', 'note': 'Requiere marcas de tiempo del choque y detección real del algoritmo', 'measured': False},
    ]
    return [{**meta, **value, 'proxy_demo': i in (1, 3)} for i, (meta, value) in enumerate(zip(INDICATORS, values))]


def ficha_minima_completa(e):
    """Integridad administrativa; NO afirma que existan videos, gravedad cierta ni vehículos conocidos.

    Una alerta de sensor puede ser útil con gravedad IND y sin video; esos valores
    se conservan explícitos, no se inventan. Este resultado es independiente
    de la completitud estricta del indicador original del Excel.
    """
    return all([
        bool(e.get('id')), bool(e.get('created_at')), bool(e.get('source')),
        bool(e.get('ubicacion')), bool(e.get('tipo')),
        e.get('st') in STATUS, e.get('p') in ('P1', 'P2', 'P3', 'IND'),
        bool(e.get('evidencia_tipo', 'sin_clip')),
    ])


def metricas_operativas(db):
    """Tiempos distintos y explícitos. Nunca equivalen a respuesta de emergencias."""
    reales = [e for e in db['events'] if not e.get('seed')]
    minimos = sum(ficha_minima_completa(e) for e in reales)
    evaluados = [e for e in reales if isinstance(e.get('evaluacion_operador'), dict)]
    coincidencias = sum(e['evaluacion_operador'].get('prioridad') == e.get('sugerencia_prioridad') for e in evaluados)
    recepcion = [float(e['procesamiento_servidor_ms']) for e in reales
                 if e.get('procesamiento_servidor_ms') is not None]
    vistas = [float(e['latency_s']) for e in reales
             if e.get('visible_at') and e.get('latency_s') is not None]
    derivaciones = []
    for e in reales:
        for h in e.get('historial', []):
            if h.get('accion') == 'derivar':
                try:
                    intervalo = (datetime.fromisoformat(h['fecha']) - datetime.fromisoformat(e['created_at'])).total_seconds()
                    derivaciones.append(max(0., intervalo))
                except (KeyError, ValueError, TypeError):
                    pass
                break
    manuales = [e for e in reales if e.get('origen') == 'app_manual']
    manuales.extend(
        {'st': 'CERRADO_FALSA_ALARMA' if v.get('descartada') else 'ALERTA_OPERADOR'}
        for e in reales for v in e.get('origenes_vinculados', [])
        if v.get('origen') == 'app_manual'
    )
    manuales_descartados = sum(e.get('st') == 'CERRADO_FALSA_ALARMA' for e in manuales)
    return {
        'reportes_ciudadanos_total': len(manuales),
        'fichas_minimas_completas': minimos,
        'fichas_minimas_total': len(reales),
        'fichas_minimas_pct': round(100 * minimos / len(reales), 1) if reales else None,
        'casos_evaluados_operador': len(evaluados),
        'coincidencias_sugerencia_operador': coincidencias,
        'coincidencias_sugerencia_pct': round(100 * coincidencias / len(evaluados), 1) if evaluados else None,
        'reportes_ciudadanos_descartados': manuales_descartados,
        'reportes_ciudadanos_descartados_pct': round(100 * manuales_descartados / len(manuales), 1) if manuales else None,
        'procesamiento_python_ms': round(sum(recepcion) / len(recepcion), 2) if recepcion else None,
        'registro_a_primera_vista_s': round(sum(vistas) / len(vistas), 1) if vistas else None,
        'registro_a_derivacion_s': round(sum(derivaciones) / len(derivaciones), 1) if derivaciones else None,
        'nota': ('Procesamiento Python = recepción de petición hasta registro local; NO mide Internet. '
                 'Primera vista = registro hasta que el dashboard consulta el caso; depende de que el panel esté abierto. '
                 'Derivación = registro hasta la acción del operador; despacho SOLO SIMULADO.')
    }


def resumen_historico(db):
    """Separa alertas recibidas, expedientes únicos y casos activos.

    Unir dos fuentes puede reducir los expedientes únicos, pero no las alertas
    recibidas. Los cinco ejemplos iniciales están explícitamente excluidos.
    """
    reales = [e for e in db['events'] if not e.get('seed')]
    return {
        'alertas_recibidas': db.get('estadisticas', {}).get('alertas_historicas', len(reales)),
        'incidentes_unicos': len(reales),
        'activos': sum(not e.get('st', '').startswith('CERRADO') for e in reales),
        'atendidos': sum(e.get('st') == 'CERRADO_ATENDIDO' for e in reales),
        'descartados': sum(e.get('st') == 'CERRADO_FALSA_ALARMA' for e in reales),
        'archivados': sum(bool(e.get('archivado', False)) for e in reales),
        'ejemplos': sum(bool(e.get('seed')) for e in db['events']),
    }


def get_state(db, incluir_ejemplos=False):
    # Sin parámetro explícito no se exponen los cinco accidentes ficticios.
    # Se conservan en disco para demostraciones opcionales, nunca en los indicadores.
    events = copy.deepcopy([e for e in db['events'] if incluir_ejemplos or not e.get('seed')])
    for e in events:
        e.pop('tracking_tokens', None)  # token privado: solo lo conoce quien registró el reporte
    events.sort(key=lambda e: (e['st'].startswith('CERRADO'),
                               0 if e.get('requiere_asistencia') else 1,
                               {'P1': 0, 'P2': 1, 'P3': 2, 'IND': 3}.get(e['p'], 4),
                               e['created_at']))
    return {
        'events': events, 'metrics': metrics(db), 'tiempos_operativos': metricas_operativas(db),
        'counts': {p: sum(e['p'] == p and not e['st'].startswith('CERRADO') for e in events)
                   for p in ('P1', 'P2', 'P3', 'IND')},
        'demo': True, 'camera_status': '0/43 cámaras reales conectadas',
        'app_status': 'app móvil preparada para integración vía API local',
        'server_time': stamp(), 'total': len(events),
        'historico': resumen_historico(db),
        'total_evaluables': sum(not e.get('seed') for e in events),
        'sources': {'app':sum(e['source']=='APP' for e in events),
                    'camara':sum(e['source']=='CAMARA' for e in events),
                    'mixtos':sum(e['source']=='CAMARA + APP' for e in events)},
    }


def apply_action(db, req):
    e = find_event(db, clean(req.get('id'), 50))
    if not e:
        raise ValueError('Incidente no encontrado.')
    act = req.get('accion')
    old = e['st']
    if act == 'evaluar':
        if old not in ('EN_REVISION', 'DERIVADO_SIMULADO'):
            raise ValueError('Primero debes tomar el caso. Los casos cerrados no se reevalúan.')
        nivel = clean(req.get('prioridad'), 8)
        tipo = clean(req.get('tipo'), 60)
        fundamento = clean(req.get('fundamento'), 400)
        fuente = clean(req.get('fuente'), 30)
        if nivel not in ('P1','P2','P3','IND') or tipo not in TYPES | {'Video para revisar'}:
            raise ValueError('Selecciona una prioridad y un tipo de evento válidos.')
        if fuente not in ('video_revisado', 'relato_ciudadano', 'sin_evidencia'):
            raise ValueError('Indica en qué basas la revisión.')
        if len(fundamento) < 8:
            raise ValueError('Explica brevemente el motivo (al menos 8 caracteres).')
        anterior = e['p']
        e.setdefault('prioridad_inicial', e.get('sugerencia_prioridad', anterior))
        e.setdefault('tipo_inicial', e.get('tipo'))
        e['p'] = nivel
        e['tipo'] = tipo
        e['evaluacion_operador'] = {
            'prioridad':nivel, 'tipo':tipo, 'fuente':fuente,
            'fundamento':fundamento, 'fecha':stamp(),
            'alcance':'EVALUACIÓN HUMANA DEMO; no es verificación independiente del modelo'
        }
        # Importante: NO ponemos clasificacion_verificada=True: hacerlo inflaría
        # fraudulentamente la precisión del detector y el indicador de clasificación.
        e.setdefault('historial', []).append({'fecha':stamp(), 'accion':'evaluar',
                                              'de': anterior, 'a': e['st'],
                                              'detalle': {'prioridad':nivel, 'tipo':tipo, 'fuente':fuente}})
        return e
    if act == 'tomar' and old == 'ALERTA_OPERADOR':
        e['st'] = 'EN_REVISION'
    elif act == 'derivar' and old == 'EN_REVISION':
        svcs = req.get('servicios')
        if not isinstance(svcs, list) or not svcs or any(s not in SERVICES for s in svcs):
            raise ValueError('Selecciona uno o más servicios.')
        e['servicios'] = list(dict.fromkeys(svcs))
        # Informe estructurado para futura derivación; NUNCA se transmite a organismos.
        e['resumen_derivacion_demo'] = {
            'fecha': stamp(), 'destinatarios': e['servicios'],
            'id': e['id'], 'ubicacion': e.get('ubicacion', 'No disponible'),
            'tipo': e.get('tipo', 'No determinado'), 'prioridad': e.get('p', 'IND'),
            'prioridad_estado': 'Revisión humana provisional' if e.get('evaluacion_operador') else 'Sugerencia por reglas sin confirmar',
            'posibles_ninos': e.get('ninos', 'no_determinada'),
            'observaciones': e.get('senales', []),
            'fuente': e.get('source'),
            'aviso': 'SIMULACIÓN SIN ENVÍO NI DESPACHO REAL'
        }
        e['st'] = 'DERIVADO_SIMULADO'
    elif act == 'falsa' and old == 'EN_REVISION':
        reason = clean(req.get('motivo'), 200)
        if not reason:
            raise ValueError('El motivo de falsa alarma es obligatorio.')
        e['motivo_cierre'] = reason
        e['st'] = 'CERRADO_FALSA_ALARMA'
    elif act == 'cerrar' and old == 'DERIVADO_SIMULADO':
        e['st'] = 'CERRADO_ATENDIDO'
    else:
        raise ValueError('Acción no permitida para el estado actual.')
    e['historial'].append({'fecha': stamp(), 'accion': act, 'de': old, 'a': e['st'],
                           'detalle': e.get('servicios', []) if act == 'derivar' else e.get('motivo_cierre', '')})
    return e



def nuevo_evento_video(db, archivo, extension, ubicacion):
    folder = ROOT / 'media' / 'uploads'
    video_id = archivo.stem
    analisis = analizar_video(archivo, folder / video_id)
    evento = create_event({'ubicacion':ubicacion or 'Archivo de prueba, ubicación no determinada',
                           'tipo':'Otro', 'vehiculos':0, 'bloqueo':'No determinado',
                           'descripcion':'Grabación subida por usuario para revisión; no es cámara UOCT en directo.'},'CAMARA')
    evento['id'] = f'EVT-{db["next_id"]:03d}'
    db['next_id'] += 1
    contabilizar_nueva_alerta(db)
    evento.update({'source':'ARCHIVO VIDEO', 'tipo':'Video para revisar', 'p':'IND',
                   'camara':'VIDEO-USUARIO', 'evidencia':f'media/uploads/{archivo.name}',
                   'evidencia_tipo':'video_usuario', 'analisis':analisis,
                   'fotogramas':[f'media/uploads/{video_id}/{t}.jpg' for t in analisis.get('fotogramas',[])],
                   'razon':'Archivo de video. Análisis exploratorio, sin detección de choque confirmada.'})
    if analisis.get('disponible'):
        evento['senales'] += [f'Cambio visual máximo en segundo {analisis["momento"]} (índice: {analisis["pico"]:.1f}% de píxeles). Indicio no confirmado.']
        if analisis.get('aviso_camara_movil'):
            evento['senales'].append('Cambios generalizados de imagen: posible movimiento de cámara; interpretación limitada.')
    else:
        evento['senales'] += [analisis.get('nota','No se pudo analizar automáticamente')]
    db['events'].append(evento)
    persist(db)
    return evento

class Handler(BaseHTTPRequestHandler):
    server_version = 'SafetyRoadDemo/1.0'

    def log_message(self, fmt, *args):
        print('[servidor]', fmt % args)

    def send_bytes(self, body, code=200, mime='application/json; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        self.wfile.write(body)

    def require_access(self):
        """Protege todas las rutas en modo público. Solo demostraciones con datos ficticios.

        La autenticación básica se debe usar únicamente detrás de HTTPS (Render/Tunnel).
        En LAN local la demo sigue siendo accesible sin contraseña por comodidad.
        """
        if not PUBLIC_MODE:
            return False
        header = self.headers.get('Authorization', '')
        ok = False
        if header.startswith('Basic '):
            try:
                raw = base64.b64decode(header[6:].strip(), validate=True).decode('utf-8')
                user, supplied = raw.split(':', 1)
                ok = secrets.compare_digest(user, 'demo') and secrets.compare_digest(supplied, DEMO_PASSWORD)
            except (ValueError, UnicodeError, base64.binascii.Error):
                pass
        if ok:
            return False
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="SafetyRoad - Prototipo educativo", charset="UTF-8"')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return True

    def send_json(self, obj, code=200):
        self.send_bytes(json.dumps(obj, ensure_ascii=False).encode('utf-8'), code)

    def get_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > 64_000:
            raise ValueError('Solicitud demasiado grande.')
        data = json.loads(self.rfile.read(length).decode('utf-8'))
        if not isinstance(data, dict):
            raise ValueError('El cuerpo debe ser un objeto JSON.')
        return data

    def serve_video(self, filepath):
        """Entrega MP4 compatible con controles de avance del navegador."""
        file_size = filepath.stat().st_size
        byte_range = self.headers.get('Range', '')
        start, end = 0, file_size-1
        code = 200
        if byte_range.startswith('bytes='):
            try:
                v=byte_range[6:].split(',')[0]
                lo,hi=v.split('-',1)
                if lo:
                    start=int(lo)
                    end=int(hi) if hi else file_size-1
                else:
                    tail=int(hi)
                    start=max(0,file_size-tail)
                end=min(file_size-1,end)
                if start<0 or start>end:raise ValueError('invalid range')
                code=206
            except (ValueError,IndexError):
                self.send_response(416)
                self.send_header('Content-Range',f'bytes */{file_size}')
                self.end_headers()
                return
        self.send_response(code)
        self.send_header('Content-Type', 'video/webm' if filepath.suffix.lower() == '.webm' else 'video/quicktime' if filepath.suffix.lower() == '.mov' else 'video/mp4')
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(end-start+1))
        if code==206:
            self.send_header('Content-Range',f'bytes {start}-{end}/{file_size}')
        self.end_headers()
        with filepath.open('rb') as video:
            video.seek(start)
            remaining=end-start+1
            while remaining:
                chunk=video.read(min(65536,remaining))
                if not chunk:break
                try:self.wfile.write(chunk)
                except (BrokenPipeError,ConnectionResetError):break
                remaining-=len(chunk)

    def do_GET(self):
        if self.require_access():
            return
        path = urlparse(self.path).path
        if path in ('/inicio', '/inicio/'):
            return self.send_bytes((ROOT / 'inicio.html').read_bytes(), mime='text/html; charset=utf-8')
        if path == '/':
            content = (ROOT / 'dashboard.html').read_bytes()
            return self.send_bytes(content, mime='text/html; charset=utf-8')
        if path == '/reporte/' or path == '/reporte':
            return self.send_bytes((ROOT / 'reporte_movil.html').read_bytes(), mime='text/html; charset=utf-8')
        if path == '/estilo_pro.css':
            return self.send_bytes((ROOT / 'estilo_pro.css').read_bytes(), mime='text/css; charset=utf-8')
        if path == '/app' or path == '/app/':
            return self.send_bytes((ROOT / 'app_demo/index.html').read_bytes(), mime='text/html; charset=utf-8')
        if path.startswith('/app/assets/') or path == '/app/favicon.png':
            relative = path.removeprefix('/app/')
            name = Path(relative)
            if '..' in name.parts or '\\' in relative:
                return self.send_json({'error':'Ruta inválida'},400)
            target=(ROOT / 'app_demo' / name).resolve()
            if not target.is_file() or not target.is_relative_to((ROOT/'app_demo').resolve()):
                return self.send_json({'error':'Recurso no encontrado'},404)
            mimetype='text/javascript; charset=utf-8' if target.suffix=='.js' else 'text/css; charset=utf-8' if target.suffix=='.css' else 'image/png'
            return self.send_bytes(target.read_bytes(), mime=mimetype)
        if path.startswith('/media/uploads/'):
            rel=Path(path.lstrip('/'))
            dest=(ROOT / rel).resolve()
            safe=(ROOT / 'media/uploads').resolve()
            if dest.is_file() and dest.is_relative_to(safe) and dest.suffix.lower() in ('.mp4','.webm','.mov','.jpg'):
                if dest.suffix.lower() in ('.mp4','.webm','.mov'):
                    return self.serve_video(dest)
                return self.send_bytes(dest.read_bytes(), mime='image/jpeg')
            return self.send_json({'error':'Archivo no encontrado'},404)
        if path == '/cliente.js':
            return self.send_bytes((ROOT / 'cliente.js').read_bytes(), mime='text/javascript; charset=utf-8')
        if path == '/api/estado':
            query = parse_qs(urlparse(self.path).query)
            incluir_ejemplos = query.get('ejemplos', ['0'])[0] == '1'
            with LOCK:
                return self.send_json(get_state(DB, incluir_ejemplos=incluir_ejemplos))
        if path == '/api/casos.csv':
            with LOCK:
                csv_text = io.StringIO()
                w = csv.writer(csv_text)
                w.writerow(['id','fecha','origen','tipo','ubicacion','vehiculos','prioridad','estado','razon','ejemplo'])
                for e in DB['events']:
                    if not e.get('seed'):
                        valores = [e.get('id',''),e.get('created_at',''),e.get('source',''),
                                   e.get('tipo',''),e.get('ubicacion',''),e.get('vehiculos',''),
                                   e.get('p',''),e.get('st',''),e.get('razon',''), 'NO']
                        # Evita interpretar como fórmulas los textos escritos por usuarios al abrir CSV en Excel.
                        w.writerow([("'" + v if isinstance(v,str) and v.lstrip().startswith(('=', '+', '-', '@')) else v)
                                    for v in valores])
                result = '\ufeff' + csv_text.getvalue()
            raw = result.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', 'attachment; filename="safetyroad_incidentes_demo.csv"')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == '/api/app/indicadores':
            with LOCK:
                total = sum(not e.get('seed') for e in DB['events'])
                return self.send_json({'metrics': metrics(DB), 'total': total,
                    'tiempos_operativos': metricas_operativas(DB),
                    'historico': resumen_historico(DB), 'demo': True,
                    'descartadas_demo': sum(e.get('st') == 'CERRADO_FALSA_ALARMA' and not e.get('seed') for e in DB['events']),
                    'canceladas_en_celular': sum(e.get('origen') == 'app_sensor_cancelado' for e in DB['events'])})
        if path == '/api/app/seguimiento':
            token = clean(parse_qs(urlparse(self.path).query).get('token',[''])[0], 80)
            with LOCK:
                e = buscar_por_token(DB, token)
                if not e:
                    return self.send_json({'error':'Código de seguimiento no encontrado.'}, 404)
                # El token permite al ciudadano consultar SOLO su expediente.
                # La derivación se comunica como SIMULADA; no representa un despacho real.
                movimientos = [
                    {'fecha': h.get('fecha', ''), 'accion': h.get('accion', ''),
                     'estado': h.get('a', ''),
                     'servicios': h.get('detalle', []) if h.get('accion') == 'derivar'
                                  and isinstance(h.get('detalle'), list) else []}
                    for h in e.get('historial', [])
                ]
                return self.send_json({
                    'id': e['id'], 'estado': e['st'], 'prioridad': e['p'],
                    'tipo': e.get('tipo'), 'ninos': e.get('ninos', 'no_determinada'),
                    'rol_reportante': e.get('rol_reportante', 'no_determinado'),
                    'gravedad_verificada': bool(e.get('clasificacion_verificada', False)),
                    'evaluacion_operador': e.get('evaluacion_operador'),
                    'requiere_asistencia': bool(e.get('requiere_asistencia', False)),
                    'actualizado': movimientos[-1]['fecha'] if movimientos else e['created_at'],
                    'fuente': e['source'], 'sugerencia': e.get('sugerencia_prioridad', 'IND'),
                    'servicios': e.get('servicios', []), 'movimientos': movimientos,
                    'resumen_derivacion_demo': e.get('resumen_derivacion_demo'),
                    'archivado': bool(e.get('archivado', False)),
                    'derivacion_simulada': True, 'despacho_real': False,
                    'demo': True
                })
        if path == '/api/salud':
            return self.send_json({'ok': True, 'modo': 'DEMO', 'conexion_camaras': False,
                                   'deteccion_accidentes_real': False,
                                   'analisis_video': 'cambios_visuales_sin_ia',
                                   'despacho_real': False})
        if path in ('/media/demo_accidente.mp4', '/media/frame_antes.jpg',
                    '/media/frame_evento.jpg', '/media/frame_despues.jpg'):
            f = ROOT / path.lstrip('/')
            if not f.exists():
                return self.send_json({'error': 'Archivo de prueba no encontrado'}, 404)
            if f.suffix == '.mp4':
                return self.serve_video(f)
            return self.send_bytes(f.read_bytes(), mime='image/jpeg')
        return self.send_json({'error': 'Recurso no encontrado'}, 404)

    def do_POST(self):
        tiempo_inicio_servidor = time.perf_counter()
        if self.require_access():
            return
        path = urlparse(self.path).path
        if path == '/api/video/subir':
            try:
                q = parse_qs(urlparse(self.path).query)
                original = unquote(q.get('nombre',['video.mp4'])[0])
                extension = Path(original).suffix.lower()
                if extension not in ('.mp4','.webm','.mov'):
                    raise ValueError('Solo se permiten MP4, WebM y MOV.')
                length = int(self.headers.get('Content-Length','0'))
                max_bytes = 15_000_000 if PUBLIC_MODE else 60_000_000
                if not 0 < length <= max_bytes:
                    raise ValueError(f'Video vacío o superior al límite de {max_bytes // 1_000_000} MB.')
                folder = ROOT / 'media' / 'uploads'
                folder.mkdir(parents=True, exist_ok=True)
                archivo = folder / ('vid_' + secrets.token_hex(8) + extension)
                with archivo.open('wb') as destino:
                    restantes = length
                    while restantes:
                        chunk = self.rfile.read(min(262144, restantes))
                        if not chunk:
                            raise ValueError('Carga incompleta.')
                        destino.write(chunk)
                        restantes -= len(chunk)
                with LOCK:
                    evt = nuevo_evento_video(DB, archivo, extension, 'Video aportado para análisis local')
                return self.send_json({'ok':True,'id':evt['id'],'analisis':evt['analisis']},201)
            except (ValueError, TypeError) as exc:
                return self.send_json({'error':str(exc)},400)
            except Exception as exc:
                print('Error al cargar video:',repr(exc))
                return self.send_json({'error':'No se pudo procesar el video.'},500)
        try:
            body = self.get_body()
            with LOCK:
                if path == '/api/camara/simular':
                    e = create_event(body, 'CAMARA')
                    e['id'] = f'EVT-{DB["next_id"]:03d}'
                    DB['next_id'] += 1
                    contabilizar_nueva_alerta(DB)
                    DB['events'].append(e)
                    for previo in DB['events']:
                        if previo.get('source') == 'APP' and not previo['st'].startswith('CERRADO'):
                            previo['coincidencias'] = posibles_coincidencias(DB, previo)
                    persist(DB)
                    return self.send_json({'ok': True, 'id': e['id'], 'p': e['p']}, 201)
                if path == '/api/app/cancelar':
                    # Contabiliza cancelaciones de simulaciones del sensor sin
                    # crear una alerta operativa ni contactar emergencias.
                    # Un ID estable de cliente evita duplicar registros ante reintentos.
                    client_id = clean(body.get('client_event_id'), 90)
                    if not client_id or not re.fullmatch(r'[a-zA-Z0-9_-]{6,90}', client_id):
                        raise ValueError('Identificador local de alerta inválido.')
                    previo = next((item for item in DB['events']
                                   if item.get('client_event_id') == client_id), None)
                    if previo:
                        return self.send_json({'ok': True, 'id': previo['id'],
                            'token':previo.get('tracking_tokens', [''])[0],
                            'estado':previo['st'], 'ya_registrado':True})
                    nuevo = create_event({
                        'origen':'app_sensor_cancelado',
                        'tipo':'Movimiento sospechoso',
                        'ubicacion':'Sin ubicación (alerta cancelada en el teléfono)',
                        'vehiculos':0, 'bloqueo':'No determinado',
                        'descripcion':'El usuario indicó Estoy bien y canceló una alerta experimental; '
                                      'no es una falsa detección confirmada.'
                    }, 'APP')
                    nuevo['id'] = f'EVT-{DB["next_id"]:03d}'
                    DB['next_id'] += 1
                    contabilizar_nueva_alerta(DB)
                    token = secrets.token_urlsafe(18)
                    nuevo['tracking_tokens'].append(token)
                    nuevo['client_event_id'] = client_id
                    nuevo['tipo'] = 'Alerta experimental cancelada'
                    nuevo['st'] = 'CERRADO_FALSA_ALARMA'
                    nuevo['no_notificada_operador'] = True
                    nuevo['razon'] = 'Cancelada por usuario antes de notificar al operador (DEMO)'
                    nuevo['motivo_cierre'] = 'Usuario indicó Estoy bien'
                    nuevo['historial'].append({'fecha':stamp(), 'accion':'cancelacion_local',
                                               'a':'CERRADO_FALSA_ALARMA'})
                    nuevo['procesamiento_servidor_ms'] = round((time.perf_counter() - tiempo_inicio_servidor) * 1000, 2)
                    DB['events'].append(nuevo)
                    persist(DB)
                    return self.send_json({'ok':True, 'id':nuevo['id'], 'token':token,
                                           'estado':nuevo['st'], 'ya_registrado':False},201)
                if path == '/api/app/reportar':
                    linked = clean(body.get('vincular_a'), 50)
                    if linked:
                        raise ValueError('La vinculación de dos fuentes requiere confirmación del operador desde el panel.')
                    ubicacion = clean(body.get('ubicacion'))
                    descripcion = clean(body.get('descripcion'), 500)
                    if not ubicacion or not descripcion:
                        raise ValueError('Para el reporte de app, ubicación y descripción son obligatorias.')
                    token = secrets.token_urlsafe(18)
                    if linked:
                        e = find_event(DB, linked)
                        if not e:
                            raise ValueError('No existe el incidente de cámara seleccionado.')
                        if e['st'].startswith('CERRADO'):
                            raise ValueError('No se puede vincular un reporte a un caso cerrado.')
                        e['reportes_app'].append({'creado': stamp(), 'ubicacion': ubicacion,
                                                  'descripcion': descripcion, 'verificado': False,
                                                  'tipo': clean(body.get('tipo'), 60),
                                                  'ninos': clean(body.get('ninos', 'no_determinada'), 40),
                                                  'rol_reportante': clean(body.get('rol_reportante', 'no_determinado'), 30)})
                        e.setdefault('tracking_tokens', []).append(token)
                        e['source'] = 'CAMARA + APP' if e.get('camara') else 'APP'
                        e['historial'].append({'fecha': stamp(), 'accion': 'reporte_app_vinculado'})
                    else:
                        e = create_event(body, 'APP')
                        e['id'] = f'EVT-{DB["next_id"]:03d}'
                        DB['next_id'] += 1
                        contabilizar_nueva_alerta(DB)
                        e['reportes_app'].append({'creado': stamp(), 'ubicacion': ubicacion,
                                                  'descripcion': descripcion, 'verificado': False,
                                                  'tipo': clean(body.get('tipo'), 60),
                                                  'ninos': clean(body.get('ninos', 'no_determinada'), 40),
                                                  'rol_reportante': clean(body.get('rol_reportante', 'no_determinado'), 30)})
                        e.setdefault('tracking_tokens', []).append(token)
                        e['coincidencias'] = posibles_coincidencias(DB, e)
                        e['procesamiento_servidor_ms'] = round((time.perf_counter() - tiempo_inicio_servidor) * 1000, 2)
                        DB['events'].append(e)
                    persist(DB)
                    return self.send_json({'ok': True, 'id': e['id'], 'vinculado': bool(linked), 'token':token, 'estado':e['st'], 'prioridad':e['p'],
                        'sugerencia':e.get('sugerencia_prioridad', 'IND'),
                        'clasificacion_verificada': False,
                        'coincidencias':e.get('coincidencias',[])}, 201)
                if path == '/api/caso/vincular':
                    e = enlazar_dos_fuentes(DB, clean(body.get('id_app'), 50), clean(body.get('id_camara'), 50))
                    persist(DB)
                    return self.send_json({'ok':True, 'id':e['id'], 'source':e['source']})
                if path == '/api/caso/accion':
                    e = apply_action(DB, body)
                    persist(DB)
                    return self.send_json({'ok': True, 'id': e['id'], 'estado': e['st']})
                if path == '/api/caso/archivar':
                    # Operador: retirar/restaurar un caso CERRADO de las vistas normales.
                    # Nunca se borra el expediente ni se alteran los indicadores.
                    e = find_event(DB, clean(body.get('id'), 50))
                    if not e:
                        raise ValueError('Incidente no encontrado.')
                    if not e.get('st', '').startswith('CERRADO'):
                        raise ValueError('Solo se pueden archivar casos cerrados.')
                    archivado = bool(body.get('archivado', True))
                    e['archivado'] = archivado
                    e.setdefault('historial', []).append({'fecha': stamp(),
                        'accion': 'archivar' if archivado else 'restaurar', 'a': e['st']})
                    persist(DB)
                    return self.send_json({'ok': True, 'id': e['id'], 'archivado': archivado})
                if path == '/api/app/archivar':
                    # Titular del token de seguimiento: archiva/restaura SOLO sus
                    # reportes cerrados. Se conserva información y estadísticas.
                    tokens = body.get('tokens', [])
                    if not isinstance(tokens, list) or len(tokens) > 100 or any(
                        not isinstance(t, str) or len(t) > 100 for t in tokens):
                        raise ValueError('Se requieren hasta 100 códigos de seguimiento válidos.')
                    archivado = bool(body.get('archivado', True))
                    cambios = []
                    for token in dict.fromkeys(tokens):
                        e = buscar_por_token(DB, clean(token, 100))
                        if not e or not e.get('st', '').startswith('CERRADO'):
                            continue
                        if bool(e.get('archivado')) == archivado:
                            continue
                        e['archivado'] = archivado
                        e.setdefault('historial', []).append({'fecha': stamp(),
                            'accion':'archivar_app' if archivado else 'restaurar_app', 'a':e['st']})
                        cambios.append(e['id'])
                    if cambios:
                        persist(DB)
                    return self.send_json({'ok': True, 'actualizados': cambios,
                                           'archivado': archivado, 'total': len(cambios)})
                if path == '/api/caso/visualizado':
                    e = find_event(DB, clean(body.get('id'), 50))
                    if not e:
                        raise ValueError('Incidente no encontrado.')
                    if not e.get('seed') and e.get('visible_at') is None:
                        current = now_dt()
                        created = datetime.fromisoformat(e['created_at'])
                        e['latency_s'] = round(max(0., (current - created).total_seconds()), 3)
                        e['visible_at'] = stamp(current)
                        persist(DB)
                    return self.send_json({'ok': True})
                if path == '/api/demo/reiniciar':
                    # En el uso habitual NO borrar los reportes ni el contador histórico.
                    # La limpieza destructiva solo se permite en pruebas automatizadas
                    # aisladas mediante variable de entorno temporal.
                    if os.environ.get('SAFETYROAD_TEST_RESET') == '1':
                        DB.clear()
                        DB.update(make_seed())
                        persist(DB)
                        return self.send_json({'ok': True, 'mensaje': 'Prueba aislada reiniciada.'})
                    guardados = [e for e in DB['events'] if not e.get('seed')]
                    ids = {e['id'] for e in guardados}
                    ejemplos = [e for e in make_seed()['events'] if e['id'] not in ids]
                    DB['events'] = ejemplos + guardados
                    # Se preservan el contador histórico, los identificadores y todos los casos.
                    persist(DB)
                    return self.send_json({'ok': True, 'mensaje': 'Ejemplos restaurados; historial real de prueba conservado.',
                                           'historico': resumen_historico(DB)})
            return self.send_json({'error': 'Ruta no encontrada'}, 404)
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({'error': str(e)}, 400)
        except Exception as e:
            print('Error interno:', repr(e))
            return self.send_json({'error': 'Error interno. Revisa la consola.'}, 500)


def main():
    url = f'http://127.0.0.1:{PORT}' if HOST == '0.0.0.0' else f'http://{HOST}:{PORT}'
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print(f'ERROR: No pude iniciar SafetyRoad en el puerto {PORT}: {exc}')
        print('Comprueba si quedó abierta otra ventana CMD con SafetyRoad y ciérrala usando Ctrl+C.')
        print('Si ya estaba ejecutándose, prueba: http://127.0.0.1:8765/app/')
        return
    print('=' * 63)
    print('   SAFETYROAD 2.0 - SERVICIO LOCAL DE REPORTES')
    print('=' * 63)
    print('Abrir en el navegador:', url)
    print('Datos persistidos en:', DB_FILE)
    print('Cámaras UOCT y despachos reales: NO CONECTADOS. No hay detector de accidentes.')
    if PUBLIC_MODE: print('ACCESO PROTEGIDO: usuario demo, clave configurada en entorno. Solo datos simulados.')
    print('App web vinculada:', url + '/app/')
    if HOST == '0.0.0.0': print('AVISO: modo LAN de demostración sin autenticación. Utilizar solo red privada de confianza.')
    print('Para detener: Ctrl+C')
    try:
        if not PUBLIC_MODE and os.environ.get('SAFETYROAD_DOS_PANTALLAS') == '1':
            webbrowser.open(url + '/app/')
            webbrowser.open_new_tab(url)
        elif not PUBLIC_MODE and os.environ.get('SAFETYROAD_AUTO_OPEN', '1') == '1':
            webbrowser.open(url + '/app/')
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print('\nServidor detenido.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
