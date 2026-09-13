"""
Agrega UN registro manual al índice de noticias con los porcentajes de
retenciones (derechos de exportación) vigentes tras el Decreto 423/2026.

ACTUALIZADO 10/09/2026 (sesión de "conseguir la fuente primaria"): la mayor
parte de este registro ya NO depende de fuentes periodísticas -- se
transcribió directo de los Anexos I, II y III del decreto, publicados como
imágenes en InfoLEG:
  https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/426351/norma.htm
(mismo contenido que el Boletín Oficial, aviso 342702/20260603; InfoLEG lo
aloja como imágenes porque así lo publicó originalmente el BORA -- el propio
decreto trae la nota "El/los Anexo/s... se publican en la edición web del
BORA"). Por qué no está en el `cuerpo` de `arca_normativa.py`: son imágenes
(tablas escaneadas), no texto -- `arca_normativa.py` solo scrapea el HTML de
`argentina.gob.ar/normativa`, que trae el cuerpo legal pero NO las imágenes
de los anexos. Automatizar esto (bajar+OCR las imágenes) queda como mejora
futura; por ahora se transcribió a mano, verificando código NCM por código
NCM contra la imagen en alta resolución.

Confirmado con NCM exacto (trigo, cebada, soja, maíz, sorgo, girasol, biodiésel).
GIRASOL, nota importante: a diferencia de lo que decía la cobertura
periodística consultada en la sesión anterior (que asumía el mismo
cronograma gradual 2027-2028 que soja/maíz/sorgo), el girasol NO tiene ese
cronograma. Su alícuota general (NCM 1206.00.90) quedó fijada en 4,5% por
el Decreto 877/2025 (11/12/2025) -- confirmado con el texto real (no
imagen) del Anexo, replicado por la Bolsa de Comercio de Córdoba:
https://www.bccba.org.ar/wp-content/uploads/2025/12/DEC-877-2025-REDUCCION-DEX.pdf
-- y el Decreto 423/2026 (Anexo II) solo retoca los casos especiales de
girasol (envases chicos con más de 15% embolsado, tipo confitería,
descascarada), nunca aparece una fila general de girasol con cronograma de
reducción gradual como sí tienen soja/maíz/sorgo. Es decir: el 4,5% general
de girasol sigue vigente sin fecha de baja conocida, salvo que aparezca
otro decreto que lo modifique.

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
    "url": "https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/426351/norma.htm",
    "titulo": "Alícuotas de retenciones (derechos de exportación) vigentes tras los Decretos 877/2025 y 423/2026 -- transcripción de los Anexos oficiales, confirmadas para todos los granos principales",
    "fecha": "10 de septiembre de 2026",
    "fecha_iso": "2026-09-10",
    "cuerpo": (
        "CONFIRMADO CONTRA LA FUENTE PRIMARIA (Anexos del Decreto 423/2026, InfoLEG/Boletín Oficial, "
        "aviso 342702/20260603 -- no son cifras de prensa):\n\n"
        "Trigo (NCM 1001.19.00): alícuota 5,50% del valor FOB. (Trigo candeal/duro para siembra, NCM "
        "1001.11.00 y 1001.91.00, tiene una alícuota distinta y menor, 1,00%, por ser semilla.)\n\n"
        "Cebada (NCM 1003.90.10, 1003.90.80, 1003.90.90): alícuota 5,50% del valor FOB.\n\n"
        "Trigo y cebada, vigencia: desde el 4 de junio de 2026 (día siguiente a la publicación), "
        "aplicación inmediata, sin cronograma de reducción posterior -- es la alícuota final, no un "
        "punto de partida de un esquema gradual.\n\n"
        "Soja, poroto (NCM 1201.90.00): 24,00% durante 2026, reduciéndose 0,25 puntos porcentuales "
        "por mes desde enero de 2027 hasta llegar a 21,00% en diciembre de 2027, y luego 0,50 puntos "
        "porcentuales por mes desde enero de 2028 hasta llegar a 15,00% desde el 1° de diciembre de "
        "2028 en adelante.\n\n"
        "Maíz (NCM 1005.90.90) y sorgo (NCM 1007.90.00): estos dos granos comparten la misma fila y "
        "el mismo cronograma en el Anexo II. 8,50% durante 2026, bajando a 7,50% en diciembre de "
        "2027, y a 5,50% desde el 1° de diciembre de 2028 en adelante.\n\n"
        "Biodiésel de aceites alternativos -- cártamo, colza, Brassica Carinata, Camelina Sativa "
        "(NCM 3826.00.00, código de referencia 'Únicamente (1)'): 0,00%, sin cronograma (ya está en "
        "el piso desde 2026).\n\n"
        "Biodiésel de soja y los demás biodiésel -- NCM 3826.00.00, código 'Excepto (1)': 21,00% "
        "durante 2026, bajando gradualmente hasta 13,00% desde el 1° de diciembre de 2028 en adelante.\n\n"
        "Aceite de soja (varias posiciones NCM 1507.x, con distintas alícuotas según el grado de "
        "refinación): el rango general baja de aproximadamente 18%-22% en 2026 a un rango de "
        "11,00%-14,00% hacia diciembre de 2028 -- dato con precisión de rango, no de código NCM "
        "puntual, porque hay varias posiciones arancelarias de aceite de soja con calendarios "
        "levemente distintos entre sí.\n\n"
        "Girasol, semilla, caso general/a granel (NCM 1206.00.90): 4,50% -- esta alícuota la fijó el "
        "Decreto 877/2025 (11 de diciembre de 2025) y el Decreto 423/2026 NO la modificó con un "
        "cronograma de baja gradual (a diferencia de soja/maíz/sorgo). El Decreto 423/2026 sólo "
        "retoca casos especiales de girasol: descascarada o tipo confitería (0,00%, sin cambios), y "
        "el caso de envases chicos con más de 15% embolsado, que sí tiene cronograma propio: 3,00% "
        "en 2026, bajando a 2,50% en diciembre de 2027 y a 2,00% desde diciembre de 2028. Pero el "
        "caso general (a granel, sin esas condiciones especiales) se mantiene en 4,50% sin fecha de "
        "baja conocida.\n\n"
        "SIN CONFIRMAR CONTRA LA FUENTE PRIMARIA:\n\n"
        "Ninguno -- con el hallazgo de girasol, todos los granos principales (trigo, cebada, soja, "
        "maíz, sorgo, girasol) y biodiésel ya están confirmados contra el texto oficial (Decretos "
        "877/2025 y 423/2026), no cifras de prensa."
    ),
    "anexos_pdf": [],
}


def main():
    if OUT_PATH.exists():
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    else:
        data = []

    # Evita duplicar si se corre este script más de una vez. También limpia
    # la URL vieja de infobae.com que usaba la versión anterior (basada en
    # prensa) de este mismo registro, para no dejar las dos dando vueltas.
    URLS_VIEJAS_A_REEMPLAZAR = {
        REGISTRO_MANUAL["url"],
        "https://www.infobae.com/economia/2026/06/03/el-gobierno-oficializo-una-reduccion-en-las-retenciones-para-el-agro-y-los-biocombustibles/",
    }
    data = [item for item in data if item.get("url") not in URLS_VIEJAS_A_REEMPLAZAR]
    data.append(REGISTRO_MANUAL)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Listo. {len(data)} comunicados en total en {OUT_PATH.resolve()}")
    print("Siguiente paso: correr chunking.py e index_pinecone.py como siempre.")


if __name__ == "__main__":
    main()
