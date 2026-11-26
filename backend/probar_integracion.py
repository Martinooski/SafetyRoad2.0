"""Prueba reproducible con datos FICTICIOS para demostrar el rol de Python.

1. Iniciar el servidor de SafetyRoad.
2. Ejecutar este archivo desde Spyder o python.
3. Abrir el dashboard: quedará un posible cruce por revisar.
"""
import json
from urllib.request import Request, urlopen

BASE = 'http://127.0.0.1:8765'


def enviar(ruta, datos):
    solicitud = Request(
        BASE + ruta,
        data=json.dumps(datos).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urlopen(solicitud) as respuesta:
        return json.loads(respuesta.read().decode('utf-8'))


camara = enviar('/api/camara/simular', {
    'tipo': 'Colisión',
    'ubicacion': 'Av. Ejemplo / Calle de prueba, La Serena',
    'vehiculos': 2,
    'bloqueo': 'Parcial',
    'camara': 'CAM-SIMULADA-01',
    'lat': -29.9555,
    'lng': -71.3499
})

app = enviar('/api/app/reportar', {
    'ubicacion': 'Av. Ejemplo / Calle de prueba, La Serena',
    'descripcion': 'Reporte de accidente de prueba desde celular',
    'vehiculos': 2,
    'bloqueo': 'Parcial',
    'lat': -29.9552,
    'lng': -71.35
})

print('ID de la cámara:', camara['id'])
print('Prioridad preliminar asignada por Python:', camara['p'])
print('ID del reporte de app:', app['id'])
print('Posibles coincidencias calculadas por Python:')
for candidato in app['coincidencias']:
    print('-', candidato['id'], '-', candidato['motivo'])
print('Abre el dashboard y confirma manualmente la vinculación.')
