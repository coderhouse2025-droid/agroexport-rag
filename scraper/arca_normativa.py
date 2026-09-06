"""
Descarga y estructura normativa de ARCA (Agencia de Recaudación y Control
Aduanero) desde el portal oficial argentina.gob.ar/normativa, para el corpus
de comercio exterior de granos.

VALIDADO manualmente el 05/09/2026 (vía fetch de una norma puntual):
  - argentina.gob.ar/normativa/nacional/norma-{ID}/texto expone cada norma
    (ARCA incluido) con texto completo en HTML plano -- no hace falta OCR
    ni extracción de PDF. Confirmado con la Resolución General 5872/2026
    (norma-427385): trajo el articulado completo, organismo, número, fecha
    de sanción y de publicación en el Boletín Oficial.
  - El HTML de esa página sigue una estructura de encabezados/etiquetas
    consistente ("Sanción:", "Publicada en el Boletín Oficial:", "Número:",
    "Texto original de la norma" ... "Acerca de esta norma"), lo cual se
    usa acá para parsear sin necesidad de una librería de scraping pesada.

NO VALIDADO -- pendiente antes de escalar esto a un scraper automático:
  - Los parámetros del buscador (argentina.gob.ar/normativa/buscar) no se
    pudieron confirmar por request directo (dos intentos con parámetros
    adivinados -combine=, field_organismo_emisor_target_id=- no filtraron
    resultados; probablemente el buscador es un formulario POST o usa
    nombres de parámetro distintos a los adivinados). Correr --dry-run
    para confirmar que el parseo de una norma puntual funciona, y si se
    quiere automatizar la *búsqueda* (no solo la descarga), hay que primero
    inspeccionar el formulario real en el navegador (DevTools > Network al
    tocar "Buscar") para sacar los nombres de parámetro correctos.

Por eso este script arranca con una lista curada a mano de normas
relevantes a granos/comercio exterior (NORMAS_CANDIDATAS), no con un
scraper de búsqueda. Cada entrada es el ID numérico que aparece en la URL
(argentina.gob.ar/normativa/nacional/norma-<ID>/texto).

Uso:
    python arca_normativa.py --dry-run   # trae y parsea solo la primera norma de la lista, la imprime
    python arca_normativa.py             # trae todas las normas de NORMAS_CANDIDATAS y guarda el índice
    python arca_normativa.py --ids 427385,123456   # override puntual de la lista curada
"""

import argparse
import json
import re
import time
from pathlib import Path
from urllib.request import urlopen, Request

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

BASE_URL = "https://www.argentina.gob.ar/normativa/nacional/norma-{id}/texto"
RATE_LIMIT_SECONDS = 1.5

# Normas candidatas identificadas manualmente (05/09/2026) por relevancia a
# comercio exterior de granos. Agregar más IDs acá a medida que se
# identifiquen -- ver docstring sobre por qué no se automatizó la búsqueda
# todavía.
NORMAS_CANDIDATAS = [
    "427385",  # RG 5872/2026 - Registro de contratos de exportación de bienes con cotización (incluye granos vía Ley 21.453)
]


def fetch_norma_html(norma_id: str) -> str:
    url = BASE_URL.format(id=norma_id)
    req = Request(url, headers={"User-Agent": "agroexport-rag-scraper/0.1 (uso institucional)"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def _fecha_por_etiqueta(html: str, etiqueta_regex: str) -> str | None:
    """Busca <dt>ETIQUETA</dt> seguido, a poca distancia, de una etiqueta
    <time datetime="AAAA-MM-DD">, que es como el sitio marca la fecha de
    sanción (confirmado 06/09/2026 contra el HTML real de norma-427385)."""
    patron = re.compile(
        r"<dt>\s*" + etiqueta_regex + r"\s*:?\s*</dt>[\s\S]{0,200}?datetime=\"([\d\-]{10})\"",
        re.IGNORECASE,
    )
    m = patron.search(html)
    return m.group(1) if m else None


def _ddmmaaaa_a_iso(fecha: str) -> str:
    dd, mm, aaaa = fecha.split("/")
    return f"{aaaa}-{mm}-{dd}"


def _extraer_entre(texto: str, inicio: str, fin: str) -> str | None:
    i = texto.rfind(inicio)  # última aparición: la primera suele estar en un bloque
    if i == -1:               # de configuración de pestañas al principio de la página, no en el contenido real
        return None
    i += len(inicio)
    j = texto.find(fin, i)
    if j == -1:
        return texto[i:].strip()
    return texto[i:j].strip()


def _limpiar_html_a_texto(fragmento_html: str) -> str:
    """Quita tags HTML dejando texto plano con saltos de línea entre bloques.
    Simple a propósito -- si el HTML real trae estructuras más anidadas que
    romper esto, conviene pasar a BeautifulSoup en vez de parchear regex."""
    texto = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", fragmento_html, flags=re.DOTALL | re.IGNORECASE)
    texto = re.sub(r"<(p|div|br|li|h[1-6])[^>]*>", "\n", texto, flags=re.IGNORECASE)
    texto = re.sub(r"<[^>]+>", "", texto)
    texto = re.sub(r"&nbsp;", " ", texto)
    texto = re.sub(r"&amp;", "&", texto)
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return texto.strip()


def parse_norma(html: str, norma_id: str) -> dict:
    """Extrae los campos relevantes de la página de una norma.
    NOTA: los nombres exactos de las etiquetas (ej. 'Sanción:') se tomaron
    de la versión renderizada (markdown) de la página vista en el navegador
    de búsqueda, no del HTML crudo directamente -- si este parser devuelve
    campos vacíos en la corrida real, es la primera señal de que la
    estructura HTML difiere de lo asumido acá, y conviene inspeccionar el
    HTML crudo de una norma con --dry-run antes de seguir."""

    titulo_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    titulo_raw = titulo_match.group(1).strip() if titulo_match else ""
    titulo = re.sub(r"\s*\|\s*Argentina\.gob\.ar\s*$", "", titulo_raw)
    titulo = re.sub(r"^TEXTO ORIGINAL\s*-\s*", "", titulo, flags=re.IGNORECASE)

    organismo_match = re.search(r"##\s*(AGENCIA DE RECAUDACION[^\n#]*)", html, re.IGNORECASE)
    organismo = organismo_match.group(1).strip() if organismo_match else "AGENCIA DE RECAUDACION Y CONTROL ADUANERO"

    numero_match = re.search(r"Resoluci[oó]n\s+General\s+(\d[\d\.]*)\s*/\s*(\d{4})", html, re.IGNORECASE)
    numero_norma = numero_match.group(1).replace(".", "") if numero_match else None
    anio = int(numero_match.group(2)) if numero_match else None

    fecha_sancion = _fecha_por_etiqueta(html, "Sanci[oó]n")

    cuerpo_raw = _extraer_entre(html, "Texto original de la norma", "Acerca de esta norma")
    cuerpo = _limpiar_html_a_texto(cuerpo_raw) if cuerpo_raw else ""

    # El pie de cada norma trae el sello clásico del Boletín Oficial, ej.:
    # "e. 03/07/2026 N° 46650/26 v. 03/07/2026" (confirmado 06/09/2026)
    boletin_match = re.search(r"e\.\s*(\d{2}/\d{2}/\d{4})\s*N[°º]\s*([\d/]+)", cuerpo)
    fecha_publicacion = _ddmmaaaa_a_iso(boletin_match.group(1)) if boletin_match else None
    boletin_numero = boletin_match.group(2) if boletin_match else None

    return {
        "documento_id": f"arca:{norma_id}",
        "titulo": titulo,
        "organismo_emisor": "ARCA",
        "organismo_emisor_completo": organismo,
        "tipo_norma": "Resolución General",
        "numero_norma": numero_norma,
        "anio": anio,
        "fecha_sancion": fecha_sancion,
        "fecha_publicacion_boletin": fecha_publicacion,
        "boletin_oficial_numero": boletin_numero,
        "url": BASE_URL.format(id=norma_id).replace("/texto", ""),
        "url_texto": BASE_URL.format(id=norma_id),
        "cuerpo": cuerpo,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ids", default=",".join(NORMAS_CANDIDATAS), help="IDs de norma separados por coma (el número que aparece en la URL, ej. 427385)")
    parser.add_argument("--out", default="../data/raw/arca_normativa_index.json")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Trae y parsea solo la primera norma de la lista, la imprime, no guarda nada. Usar para validar el parser antes de correr todo.",
    )
    parser.add_argument(
        "--dump-html",
        action="store_true",
        help="Guarda el HTML crudo de la primera norma en arca_debug_<id>.html, para inspeccionar a mano cuando el parser falla en algún campo.",
    )
    args, _unknown = parser.parse_known_args()

    ids = [i.strip() for i in args.ids.split(",") if i.strip()]

    if args.dump_html:
        norma_id = ids[0]
        print(f"[dump-html] pidiendo norma-{norma_id}...")
        html = fetch_norma_html(norma_id)
        debug_path = SCRIPT_DIR / f"arca_debug_{norma_id}.html"
        debug_path.write_text(html, encoding="utf-8")
        print(f"Guardado en: {debug_path.resolve()}")
        print("Abrilo con el Bloc de notas o VS Code y buscá (Ctrl+F) 'Sanci' y 'Bolet\u00edn' para ver cómo está marcado el dato de fecha ahí.")
        return

    if args.dry_run:
        norma_id = ids[0]
        print(f"[dry-run] pidiendo norma-{norma_id}...")
        html = fetch_norma_html(norma_id)
        parsed = parse_norma(html, norma_id)
        for k, v in parsed.items():
            preview = (v[:200] + "…") if isinstance(v, str) and len(v) > 200 else v
            print(f"  {k}: {preview}")
        print("\nSi 'titulo', 'numero_norma' y 'cuerpo' se ven bien poblados, correr sin --dry-run.")
        print("Si algún campo salió None o vacío, revisar parse_norma() contra el HTML crudo real")
        print("(no el markdown) de esta URL: " + BASE_URL.format(id=norma_id))
        return

    resultados = []
    for norma_id in ids:
        print(f"[bajando] norma-{norma_id}")
        try:
            html = fetch_norma_html(norma_id)
            parsed = parse_norma(html, norma_id)
            resultados.append(parsed)
        except Exception as e:
            print(f"  [error] {e}")
        time.sleep(RATE_LIMIT_SECONDS)

    out_path = SCRIPT_DIR / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nTotal normas bajadas: {len(resultados)}")
    print(f"Guardado en: {out_path.resolve()}")
    print("Siguiente paso: agregar un build_chunks_arca() a chunking.py (mismo patrón que build_chunks_noticias),")
    print("ya que este JSON ya trae 'cuerpo' en texto plano, sin necesidad de extract_text_local.py.")


if __name__ == "__main__":
    main()
