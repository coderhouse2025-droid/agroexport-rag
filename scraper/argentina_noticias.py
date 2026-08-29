"""
Scraper de comunicados de protocolos de exportación en argentina.gob.ar/noticias.

A diferencia del Repositorio (Omeka), argentina.gob.ar no tiene un endpoint de
búsqueda/listado público confiable -- es un sitio institucional Drupal. Por eso
el flujo acá es semi-manual:

  1. Buscar (web o site:argentina.gob.ar/noticias) comunicados relevantes por
     producto/país -- ej. "exportadores granos China", "protocolo soja Brasil",
     "requisitos fitosanitarios maiz Union Europea".
  2. Juntar las URLs encontradas en URLS_A_SCRAPEAR (abajo) o en un .txt aparte.
  3. Correr este script para bajar el contenido completo de cada una, incluidos
     los links a los Anexos en PDF que suelen traer estos comunicados.

Cada comunicado trae: fecha de publicación, cuerpo completo, y links a PDFs de
anexos con los requisitos concretos (ver ejemplo ya confirmado: convocatoria de
exportadores de granos a China, vigente 24/08 al 06/09/2026, con Anexos II/III/V/VI).

IMPORTANTE (ajuste post-búsqueda Brasil/UE/India): a diferencia de China, que
tiene convocatorias periódicas publicadas como noticia individual, Brasil y la
Unión Europea NO tienen protocolos de granos publicados como "noticia" -- sus
requisitos viven en páginas fijas del Portal de Certificación Fitosanitaria de
Exportación de SENASA (no son "noticias", son páginas de sección/"book", por
lo que este scraper de noticias no las va a levantar; ver nota más abajo y el
README para el detalle). India tampoco tiene página de protocolo dedicada:
sus requisitos son un PDF único (Plant Quarantine Order 2003) listado en
"Documentación oficial de las ONPF". Por eso la lista de abajo mezcla:
  (a) noticias puntuales (formato que este script sabe parsear), y
  (b) URLs de referencia que NO son noticias y quedan documentadas aparte
      (no las pases a este script; ver README "Fuentes de datos").

Requiere: pip install beautifulsoup4 requests --break-system-packages

Uso:
    python argentina_noticias.py --urls urls.txt
"""

import argparse
import datetime
import json
import re
import time
from pathlib import Path
from urllib.request import urlopen, Request

from bs4 import BeautifulSoup

RATE_LIMIT_SECONDS = 1.0

MESES_ES = {
    1: "enero", 2: "febrero", 3: "marzo", 4: "abril", 5: "mayo", 6: "junio",
    7: "julio", 8: "agosto", 9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre",
}


def parse_fecha_iso(iso_str: str):
    """Convierte 'article:published_time' (ISO, ej 2026-08-24T10:00:00-03:00)
    a ('24 de agosto de 2026', '2026-08-24'). Devuelve (None, None) si falla."""
    try:
        dt = datetime.datetime.fromisoformat(iso_str)
        legible = f"{dt.day:02d} de {MESES_ES[dt.month]} de {dt.year}"
        return legible, dt.date().isoformat()
    except (ValueError, KeyError):
        return None, None

# __file__ no existe si este código se pega y corre directo en una celda de
# Colab/Jupyter (en vez de ejecutarse como archivo .py con `python script.py`).
# Con este fallback, las rutas relativas (../data/raw/...) se resuelven contra
# el directorio de trabajo actual en ese caso.
try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

# Lista de noticias confirmadas -- ir agregando a medida que se buscan más.
# Todas estas SÍ tienen formato de noticia (título + fecha + cuerpo + anexos)
# y pueden pasarse directamente a este script.
URLS_A_SCRAPEAR = [
    # China -- convocatoria vigente (24/08 al 06/09/2026), con Anexos II/III/V/VI
    "https://www.argentina.gob.ar/noticias/inscripcion-para-exportadores-de-granos-de-cebada-trigo-soja-sorgo-y-maiz-china-3",
    # China -- noticia fundacional del acuerdo bilateral de granos (contexto/historia del protocolo)
    "https://www.argentina.gob.ar/noticias/protocolo-de-requisitos-fitosanitarios-para-la-exportacion-de-granos-china",
    # Brasil -- incorporación de Brasil al sistema ePhyto (certificación fitosanitaria electrónica);
    # menciona trigo y cebada como productos exportados, aunque no es un "protocolo" específico de granos
    "https://www.argentina.gob.ar/noticias/argentina-comienza-usar-certificacion-fitosanitaria-electronica-para-exportar-brasil",
]

# URLs de referencia NO-noticia encontradas para Brasil / UE / India.
# No pasarlas a este script (fallarían el parseo de <h1> + fecha "DD de mes de AAAA").
# Quedan documentadas acá para que el próximo paso (scraper de páginas de sección)
# las use como fuente. Ver README > Fuentes de datos.
URLS_REFERENCIA_NO_NOTICIA = {
    "brasil": "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportacion/brasil",
    "union_europea": "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportacion/union-europea",
    # Nota: la página de Brasil/UE en este portal es genérica del país (en el caso de
    # UE, hoy solo tiene el instructivo de fruta fresca cítrica -- NO granos). El listado
    # completo de protocolos por país está en:
    "indice_protocolos_por_pais": "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportacion/protocolos-de-exportacion",
    # India no tiene página de protocolo dedicada: su requisito es este PDF único
    "india_plant_quarantine_order_2003": "https://www.argentina.gob.ar/sites/default/files/pqorder2015.pdf",
    # Listado completo de países + requisitos (permisos de importación vs. normas generales),
    # incluye Brasil, India y UE explícitamente
    "documentacion_oficial_onpf": "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportaci%C3%B3n/documentacion-oficial-de-las-onpf",
}


def fetch_html(url: str) -> str:
    req = Request(url, headers={"User-Agent": "agroexport-rag/0.1 (uso institucional)"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_noticia(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    # BUG conocido y corregido: argentina.gob.ar tiene DOS <h1> por página --
    # uno de branding institucional ("Presidencia de la Nación") al principio
    # del HTML, y el título real de la noticia más abajo, dentro del contenido.
    # soup.find("h1") siempre devolvía el primero (el branding), no el título.
    # Se prioriza el meta og:title (mucho más confiable) y, si no está, se usa
    # el ÚLTIMO <h1> de la página en vez del primero.
    og_title = soup.find("meta", attrs={"property": "og:title"})
    if og_title and og_title.get("content"):
        title = og_title["content"].strip()
    else:
        h1_tags = soup.find_all("h1")
        title = h1_tags[-1].get_text(strip=True) if h1_tags else ""

    # El cuerpo de la noticia vive en el contenido principal; buscamos el bloque
    # de texto entre el título y la sección "Noticias relacionadas"
    main = soup.find("main") or soup.find("article") or soup.body
    paragraphs = [p.get_text(" ", strip=True) for p in main.find_all("p")] if main else []
    body_text = "\n".join(p for p in paragraphs if p)

    # Links a PDFs (anexos, formularios)
    pdf_links = []
    if main:
        for a in main.find_all("a", href=True):
            href = a["href"]
            if href.lower().endswith(".pdf"):
                pdf_links.append({"texto": a.get_text(strip=True), "url": href})

    # BUG conocido y corregido: el texto visible del cuerpo a veces menciona
    # fechas sin año pegado (ej. "desde el 24 de agosto y hasta el 6 de
    # septiembre"), así que buscar el patrón "DD de mes de AAAA" en el cuerpo
    # devolvía None en varios casos aunque la noticia sí tuviera fecha.
    # La fecha real y confiable vive en el meta "article:published_time"
    # (formato ISO) que trae cada página. Se usa como fuente primaria y se
    # guarda también en formato ISO (mejor para ordenar/filtrar vigente vs no
    # vigente, que es el próximo paso del pipeline según el README).
    fecha = fecha_iso = None
    meta_fecha = soup.find("meta", attrs={"property": "article:published_time"})
    if meta_fecha and meta_fecha.get("content"):
        fecha, fecha_iso = parse_fecha_iso(meta_fecha["content"])
    if not fecha:
        fecha_match = re.search(r"\d{1,2} de \w+ de \d{4}", body_text)
        fecha = fecha_match.group(0) if fecha_match else None

    return {
        "url": url,
        "titulo": title,
        "fecha": fecha,
        "fecha_iso": fecha_iso,
        "cuerpo": body_text,
        "anexos_pdf": pdf_links,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--urls", help="Archivo .txt con una URL por línea. Si no se pasa, usa URLS_A_SCRAPEAR.")
    parser.add_argument("--out", default="../data/raw/argentina_noticias_index.json")
    # parse_known_args (en vez de parse_args) ignora argumentos que el script no
    # reconoce -- necesario en Colab/Jupyter, que inyecta su propio "-f kernel.json"
    # a sys.argv y rompería un parse_args() estricto.
    args, _unknown = parser.parse_known_args()

    if args.urls:
        urls = [line.strip() for line in Path(args.urls).read_text(encoding="utf-8").splitlines() if line.strip()]
    else:
        urls = URLS_A_SCRAPEAR

    results = []
    for url in urls:
        print(f"[bajando] {url}")
        try:
            html = fetch_html(url)
            item = parse_noticia(html, url)
            results.append(item)
            print(f"  -> '{item['titulo']}' | {len(item['anexos_pdf'])} anexos PDF")
        except Exception as e:
            print(f"  [error] {e}")
        time.sleep(RATE_LIMIT_SECONDS)

    out_path = SCRIPT_DIR / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(results)} comunicados procesados. Guardado en: {out_path.resolve()}")


if __name__ == "__main__":
    main()
