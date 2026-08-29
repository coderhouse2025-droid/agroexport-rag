"""
Scraper del Repositorio Institucional de SENASA (biblioteca.senasa.gob.ar)
para el corpus de granos y oleaginosas.

VALIDADO el 25/08/2026:
  - El parámetro correcto de búsqueda por palabra clave es 'search'
    (ej. ?search=soja) y SÍ filtra correctamente -- confirmado navegando
    manualmente items/browse?search=soja (25 resultados, todos relevantes).
  - output=json en items/browse solo trae metadata mínima (id, fechas,
    collection_id) -- NO trae título/descripción, exigiría un segundo
    llamado a items/show/{id}?output=json por cada ítem.
  - output=rss2 trae en un solo llamado: título, descripción, autor,
    fecha, tipo, resumen y el link directo al PDF. Es el formato elegido
    para este scraper por eficiencia (1 request = 1 página de resultados
    completa, no 1 request por ítem).

VALIDADO EN LA PRIMERA CORRIDA REAL:
  - La combinación 'output=rss2&search=<keyword>&page=N' funciona correctamente
    end-to-end. Confirmado porque el índice resultante (`senasa_repositorio_index.json`)
    trae 234 documentos únicos repartidos en 8 keywords, varias de ellas con más
    de 50 resultados (ej. 'fitosanitario'), lo cual solo es posible si la
    paginación efectivamente avanzó de página en página.

Uso:
    python senasa_repositorio.py --keywords soja,maiz,trigo,girasol,oleaginosas
    python senasa_repositorio.py --dry-run   # trae solo la primera página de 'soja' y la imprime
"""

import argparse
import json
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen, Request

BASE_URL = "https://biblioteca.senasa.gob.ar"
BROWSE_ENDPOINT = f"{BASE_URL}/items/browse"
RATE_LIMIT_SECONDS = 1.0
PER_PAGE = 50  # Omeka pagina de a 50 por default en RSS/browse

# __file__ no existe si este código se pega y corre directo en una celda de
# Colab/Jupyter (en vez de ejecutarse como archivo .py con `python script.py`).
# Con este fallback, las rutas relativas (../data/raw/...) se resuelven contra
# el directorio de trabajo actual en ese caso. (Mismo fix aplicado en
# argentina_noticias.py tras encontrar el mismo error ahí.)
try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

DEFAULT_KEYWORDS = [
    "soja",
    "maiz",
    "trigo",
    "girasol",
    "oleaginosas",
    "granos",
    "cereales",
    "fitosanitario",
]


def fetch_rss_page(search: str, page: int) -> str:
    """Trae una página de resultados en RSS2 (XML) para una keyword."""
    params = {"output": "rss2", "search": search, "page": page}
    url = f"{BROWSE_ENDPOINT}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": "agroexport-rag-scraper/0.2 (uso institucional)"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_rss_items(xml_text: str) -> list[dict]:
    """Extrae los campos relevantes de cada <item> del RSS2 de Omeka."""
    root = ET.fromstring(xml_text)
    items = []
    for item_el in root.findall(".//item"):
        title = (item_el.findtext("title") or "").strip()
        link = (item_el.findtext("link") or "").strip()
        description_html = item_el.findtext("description") or ""

        # El link al PDF viene embebido en el HTML de <description> como
        # <a class="download-file" href="...">
        pdf_url = None
        marker = 'class="download-file" href="'
        idx = description_html.find(marker)
        if idx != -1:
            start = idx + len(marker)
            end = description_html.find('"', start)
            pdf_url = description_html[start:end]

        items.append(
            {
                "titulo": title,
                "item_url": link,
                "pdf_url": pdf_url,
                "descripcion_raw_html": description_html,
            }
        )
    return items


def search_keyword(keyword: str, max_pages: int = 20) -> list[dict]:
    """Recorre páginas de resultados RSS para una keyword hasta agotarlas."""
    results = []
    page = 1
    while page <= max_pages:
        xml_text = fetch_rss_page(keyword, page)
        items = parse_rss_items(xml_text)
        if not items:
            break
        results.extend(items)
        if len(items) < PER_PAGE:
            break  # última página
        page += 1
        time.sleep(RATE_LIMIT_SECONDS)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keywords", default=",".join(DEFAULT_KEYWORDS))
    parser.add_argument("--out", default="../data/raw/senasa_repositorio_index.json")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Trae solo 1 página de la primera keyword y la imprime, sin guardar nada. Usar para validar antes de correr todo.",
    )
    args, _unknown = parser.parse_known_args()

    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]

    if args.dry_run:
        kw = keywords[0]
        print(f"[dry-run] pidiendo página 1 de '{kw}'...")
        xml_text = fetch_rss_page(kw, page=1)
        items = parse_rss_items(xml_text)
        print(f"[dry-run] {len(items)} items encontrados en la página 1")
        for it in items[:5]:
            print(f"  - {it['titulo']}  ->  pdf: {it['pdf_url']}")
        print("\nSi esto se ve bien (títulos relacionados con la keyword y pdf_url no vacío),")
        print("correr sin --dry-run para bajar todo el corpus de keywords.")
        return

    seen_urls = set()
    all_items = []
    for kw in keywords:
        print(f"[buscando] '{kw}'")
        raw_items = search_keyword(kw)
        print(f"  -> {len(raw_items)} resultados")
        for item in raw_items:
            if item["item_url"] not in seen_urls:
                seen_urls.add(item["item_url"])
                item["keyword_match"] = kw
                all_items.append(item)
        time.sleep(RATE_LIMIT_SECONDS)

    out_path = SCRIPT_DIR / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(all_items, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nTotal documentos únicos: {len(all_items)}")
    print(f"Índice guardado en: {out_path.resolve()}")
    print("Siguiente paso: downloader.py para bajar los PDFs listados en 'pdf_url'.")


if __name__ == "__main__":
    main()
