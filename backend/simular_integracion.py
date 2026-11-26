"""DOS FUENTES INDEPENDIENTES -> BACKEND PYTHON -> UN SOLO INCIDENTE.

Ejecutar con servidor.py ya abierto:
    python simular_integracion.py

Es una demostración de envío de datos HTTP, no conexión con UOCT ni app real.
"""
import json
import os
from urllib.error import URLError
from urllib.request import Request, urlopen

BASE = os.environ.get('SAFETYROAD_URL', 'http://127.0.0.1:8765')


def enviar(ruta, datos):
    solicitud = Request(BASE + ruta,
        data=json.dumps(datos, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(solicitud, timeout=5) as respuesta:
        return json.load(respuesta)


def main():
    print('SafetyRoad: flujo de dos fuentes de prueba (NO conexiones reales)')
    print('1. Un modulo de camara simulado envia una deteccion a Python...')
    camara = enviar('/api/camara/simular', {
        'camara': 'CAM-DEMO-EXTERNA',
        'tipo': 'Colisión múltiple',
        'ubicacion': 'Av. Cuatro Esquinas, La Serena (ejemplo ficticio)',
        'vehiculos': 3,
        'bloqueo': 'Total',
        'visibilidad': 'Normal',
        'ninos': 'no_determinada',
        'descripcion': 'Posible colision detectada por fuente de prueba',
    })
    print(f'   Caso creado: {camara["id"]} / Prioridad: {camara["p"]}')
    print('2. Una app simulada envia un reporte vinculado al mismo caso...')
    app = enviar('/api/app/reportar', {
        'vincular_a': camara['id'],
        'ubicacion': 'Av. Cuatro Esquinas, La Serena (ejemplo ficticio)',
        'descripcion': 'Reporte ficticio: usuario indica choque con varios vehiculos',
    })
    print(f'   Reporte asociado: {app["id"]}. Fusion: {app["vinculado"]}')
    print('3. Abre el dashboard y selecciona', camara['id'])
    print('   La ficha debe indicar CAMARA + APP con un reporte asociado.')


if __name__ == '__main__':
    try:
        main()
    except (URLError, ConnectionError) as exc:
        print('No se pudo conectar con el servidor. Ejecuta primero: python servidor.py')
        print('Detalle:', exc)
