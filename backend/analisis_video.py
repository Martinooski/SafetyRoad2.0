"""SafetyRoad 2.0 - análisis exploratorio de videos sin modelos de IA.

Este módulo mide cambios entre fotogramas con OpenCV y guarda capturas para
revisión humana. NO detecta vehículos, colisiones ni gravedad de accidentes.
"""
from pathlib import Path


def analizar_video(archivo, carpeta_imagenes):
    try:
        import cv2
        import numpy as np
    except ImportError:
        return {'disponible': False, 'nota': 'OpenCV o NumPy no instalado. Instala opencv-python.',
                'segundos': None, 'momento': None, 'pico': None, 'fotogramas': [],
                'deteccion_accidente': False}

    cap = cv2.VideoCapture(str(archivo))
    if not cap.isOpened():
        return {'disponible': False, 'nota': 'No se pudo decodificar el archivo como video.',
                'segundos': None, 'momento': None, 'pico': None, 'fotogramas': [],
                'deteccion_accidente': False}
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not np.isfinite(fps) or fps <= 0:
            fps = 25
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duracion = round(count / fps, 2) if count else None
        limite = min(duracion if duracion is not None else 180, 180)
        muestras = []
        instante = 0.0
        anterior = None
        while instante <= limite:
            cap.set(cv2.CAP_PROP_POS_MSEC, instante * 1000)
            ok, frame = cap.read()
            if not ok:
                break
            gris = cv2.cvtColor(cv2.resize(frame, (256, 144)), cv2.COLOR_BGR2GRAY)
            gris = cv2.GaussianBlur(gris, (7, 7), 0)
            if anterior is not None:
                diferencia = cv2.absdiff(anterior, gris)
                porcentaje = float((diferencia > 35).mean() * 100)
                muestras.append((round(instante, 2), round(porcentaje, 2)))
            anterior = gris
            instante += 0.5
        if not muestras:
            return {'disponible': False,
                    'nota': 'Video demasiado corto o sin fotogramas decodificables.',
                    'segundos': duracion, 'momento': None, 'pico': None, 'fotogramas': [],
                    'deteccion_accidente': False}
        momento, pico = max(muestras, key=lambda fila: fila[1])
        valores = np.array([x[1] for x in muestras], dtype=float)
        media = round(float(np.median(valores)), 2)
        alto_global = round(float((valores > 55).mean() * 100), 1)
        # Distanciar picos al menos 1.5 s para evitar repetir el mismo instante.
        destacados = []
        for tiempo, cambio in sorted(muestras, key=lambda fila: fila[1], reverse=True):
            if all(abs(tiempo - otro['segundo']) >= 1.5 for otro in destacados):
                destacados.append({'segundo': tiempo, 'cambio_pct': cambio})
                if len(destacados) == 3:
                    break
        carpeta_imagenes = Path(carpeta_imagenes)
        carpeta_imagenes.mkdir(parents=True, exist_ok=True)
        fotos = []
        for titulo, segundo in [('antes', max(0, momento - 2)), ('evento', momento),
                               ('despues', min(duracion or momento + 2, momento + 2))]:
            cap.set(cv2.CAP_PROP_POS_MSEC, segundo * 1000)
            ok, frame = cap.read()
            if ok:
                h, w = frame.shape[:2]
                if w > 800:
                    frame = cv2.resize(frame, (800, round(h * 800 / w)))
                filename = carpeta_imagenes / f'{titulo}.jpg'
                if cv2.imwrite(str(filename), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80]):
                    fotos.append(titulo)
        return {
            'disponible': True,
            'metodo': 'diferencias_de_fotogramas',
            'nota': 'Cambio visual exploratorio. No demuestra impacto, causa ni gravedad.',
            'segundos': duracion, 'momento': momento, 'pico': pico,
            'fotogramas': fotos, 'muestras': len(muestras),
            'mediana_cambio_pct': media,
            'fotogramas_con_cambio_extenso_pct': alto_global,
            'picos': destacados,
            'aviso_camara_movil': alto_global >= 30,
            'deteccion_accidente': False,
            'segmento_analizado_segundos': round(limite, 1),
        }
    finally:
        cap.release()
