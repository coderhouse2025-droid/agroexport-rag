"""
Agrega UN registro manual al índice de noticias con los porcentajes exactos
de retenciones (derechos de exportación) vigentes tras el Decreto 423/2026.

Por qué esto es manual y no un scraper: el Decreto 423/2026 (ver
arca_normativa.py, norma-426351) fija las alícuotas remitiendo a 3 Anexos
(archivos GDE tipo IF-2026-...-APN-SSMAEII#MEC) que no tienen URL pública
descargable -- son adjuntos internos del sistema de gestión documental del
Estado, probablemente PDFs tabulares/escaneados. El texto del decreto en sí
(VISTO/CONSIDERANDO/artículos) NUNCA menciona un porcentaje concreto, solo
remite al Anexo. Confirmado 10/09/2026 corriendo:
    python -c "import json; ...; print('Alícuota' in item['cuerpo'])"
  -> False (ver historial de la sesión).

El comunicado oficial de argentina.gob.ar (agregado a argentina_noticias.py)
tampoco alcanza: usa lenguaje relativo ("reducción de 2 puntos porcentuales",
"0,25 puntos porcentuales mensuales") sin el valor absoluto de partida/llegada.

Los números de abajo se armaron cruzando 3 fuentes periodísticas
especializadas que SÍ los dan en términos absolutos y que coinciden entre sí
(La Nación, Infobae, Infocampo -- todas del 03/06/2026, día de publicación
del decreto). No se agregaron como "scraper" nuevo por dominio (hubiera
significado escribir selectores de BeautifulSoup por sitio para un solo
dato puntual) -- se transcribe acá a mano, citando bien la fuente, que es
más simple y menos fragil que automatizar el scraping de 3 sitios de noticias
distintos para esto.

IMPORTANTE -- revisar antes de dar por cerrado este pendiente: son cifras de
prensa, no el texto legal en sí. Si en algún momento se consigue acceso al
Anexo real (ej. pidiendo el PDF directo al Boletín Oficial, o alguien lo baja
a mano y lo procesa con extract_text_local.py), reemplazar esto por la fuente
primaria.

Uso (una sola vez, después de correr argentina_noticias.py):
    python agregar_retenciones_manual.py
"""

import json
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

OUT_PATH = SCRIPT_DIR / "../data/raw/argentina_noticias_index.json"

REGISTRO_MANUAL = {
    "url": "https://www.infobae.com/economia/2026/06/03/el-gobierno-oficializo-una-reduccion-en-las-retenciones-para-el-agro-y-los-biocombustibles/",
    "titulo": "Resumen verificado: alícuotas de retenciones (derechos de exportación) vigentes tras el Decreto 423/2026",
    "fecha": "10 de septiembre de 2026",
    "fecha_iso": "2026-09-10",
    "cuerpo": (
        "Nota: este registro es un resumen elaborado a mano el 10/09/2026, cruzando cobertura "
        "periodística de La Nación, Infobae e Infocampo sobre el Decreto 423/2026 (publicado el "
        "03/06/2026), porque el texto legal del decreto remite las alícuotas concretas a Anexos "
        "que no están disponibles como texto plano. Verificar contra el Boletín Oficial "
        "(https://www.boletinoficial.gob.ar/detalleAviso/primera/342702/20260603) antes de tomar "
        "una decisión operativa o de pago.\n\n"
        "Trigo y cebada: la alícuota bajó de 7,5% a 5,5% (dos puntos porcentuales), vigente desde "
        "el 4 de junio de 2026 (día siguiente a la publicación del decreto), de aplicación "
        "inmediata.\n\n"
        "Soja (poroto): 24% durante 2026, baja a 21% desde diciembre de 2027, y a 15% desde "
        "diciembre de 2028. El cronograma de baja gradual para este grano arranca en enero de "
        "2027 (0,25 puntos porcentuales por mes desde enero de 2027, y 0,5 puntos por mes desde "
        "enero de 2028).\n\n"
        "Aceite de soja: baja del rango actual de 18%-22% a un rango de 11%-14% hacia fines de "
        "2028.\n\n"
        "Maíz y sorgo: bajan del 8,5% actual a 7,5% a fines de 2027 y a 5,5% desde diciembre de "
        "2028; algunas posiciones arancelarias específicas de estos granos quedan con retención "
        "0%.\n\n"
        "Girasol: incluido en el mismo cronograma gradual que soja/maíz/sorgo (mismo esquema "
        "2027-2028), sin una cifra puntual encontrada por separado en las fuentes consultadas.\n\n"
        "Biodiésel: retención 0% si se elabora a partir de aceites 'alternativos' (carinata, "
        "cártamo, colza, camelina). El biodiésel de soja baja del 21% actual al 13% en diciembre "
        "de 2028.\n\n"
        "Contexto normativo: el Decreto 423/2026 continúa el esquema permanente de reducción ya "
        "establecido por los Decretos 526/2025 y 877/2025 (ver normas arca:421243 en este mismo "
        "RAG)."
    ),
    "anexos_pdf": [],
}


def main():
    if OUT_PATH.exists():
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    else:
        data = []

    # Evita duplicar si se corre este script más de una vez
    data = [item for item in data if item.get("url") != REGISTRO_MANUAL["url"]]
    data.append(REGISTRO_MANUAL)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Listo. {len(data)} comunicados en total en {OUT_PATH.resolve()}")
    print("Siguiente paso: correr chunking.py e index_pinecone.py como siempre.")


if __name__ == "__main__":
    main()
