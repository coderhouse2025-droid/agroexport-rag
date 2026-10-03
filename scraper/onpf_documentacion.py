
"""
Scraper de la página "Documentación oficial de las ONPF" de SENASA.

A diferencia del Portal de Certificación Fitosanitaria de Exportación (que tiene
una página por país, pero está dominado por fruta fresca -- ajo, limón, manzana,
pomelo -- ver README, sesión 28/09/2026), esta página SÍ es específica de granos
y subproductos: trae una tabla con países que requieren intervención obligatoria
de SENASA para harinas/expellers/pellets/tortas de soja y girasol, citando su
base legal (Resolución SENASA N° 37/2017, que modifica la 260/2014).

También trae una segunda sección, "Países que comunican sus requisitos en Normas
o Directivas", con la normativa general que aplica en cada caso (ej. India: Plant
Quarantine Order 2003; UE: Directiva 2000/29/EC) -- coincide con lo que el README
ya tenía documentado a mano para esos dos países.

IMPORTANTE -- sin probar contra el sitio real: este scraper se escribió y probó
con un fixture armado a partir del contenido de la página (bajado a mano el
28/09/2026), no corriendo contra argentina.gob.ar (este entorno no tiene salida
de red a ese dominio). La primera corrida real puede necesitar ajustes si la
estructura del HTML difiere de lo esperado -- punto más probable de falla:
soup.find("table") si la página tiene más de una tabla, o si los headers de
sección cambiaron de texto. Correr con --debug la primera vez y revisar la
salida antes de confiar en el JSON generado.

Requiere: pip install beautifulsoup4 --break-system-packages

Uso:
    python onpf_documentacion.py
    python onpf_documentacion.py --debug   # imprime lo que encontró en cada sección
"""

import argparse
import json
import re
from pathlib import Path
from urllib.request import urlopen, Request

from bs4 import BeautifulSoup

URL = "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportaci%C3%B3n/documentacion-oficial-de-las-onpf"

BASE_LEGAL = (
    "Resolución SENASA N° 37/2017 (modifica el Artículo 1° de la Resolución SENASA "
    "N° 260/2014): todos los embarques de productos y subproductos de granos para "
    "exportación deben someterse al control fitosanitario y de calidad de SENASA. "
    "Quedan exceptuados los aceites, harinas, pellets, expellers y tortas de "
    "cereales y oleaginosas, SALVO que el país de destino lo exija -- por eso "
    "existe este listado de países donde sí es obligatorio."
)

# Cultivos del alcance del proyecto que aparecen en la columna "Producto" de la
# tabla (para poblar el campo "cultivos" de cada chunk, igual que hace
# _detectar_cultivos en chunking.py para ARCA).
CULTIVOS_EN_PRODUCTO = {
    "soja": "soja",
    "girasol": "girasol",
    "maíz": "maíz",
    "maiz": "maíz",
    "maní": "maní",  # no es cultivo del alcance del proyecto, pero aparece en la tabla (torta de maní) -- se detecta igual, por las dudas
    "lino": "lino",  # ídem
}

# Países/entidades que efectivamente aparecen como encabezado de su propio bloque
# en la sección "Países que comunican sus requisitos en Normas o Directivas" de
# la página real (confirmado al bajarla a mano el 28/09/2026). Hace falta esta
# lista porque, en el HTML, un país cuyo nombre ES el link (ej. "Chile") es
# estructuralmente idéntico a un link suelto que sigue hablando del país anterior
# (ej. "Instrucciones Normativas" después de Brasil) -- un <p> con un solo <a> y
# nada de texto alrededor, en los dos casos. No hay forma de distinguirlos sin
# saber de antemano cuáles son nombres de país. Si SENASA agrega o saca un país
# de esta sección, hay que actualizar esta lista (correr con --debug para ver
# qué nombres aparecen y compararlos).
PAISES_NORMATIVA_GENERAL_CONOCIDOS = {
    "argelia", "brasil", "chile", "india", "israel", "marruecos", "montenegro",
    "unión europea", "union europea", "países miembros de la unión europea",
    "estados unidos", "puerto rico",
}


def _es_nombre_de_pais_conocido(texto: str) -> bool:
    return texto.strip().lower() in PAISES_NORMATIVA_GENERAL_CONOCIDOS


def fetch_html(url: str) -> str:
    req = Request(url, headers={"User-Agent": "agroexport-rag/0.1 (uso institucional)"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def _detectar_cultivos_en_texto(texto: str) -> list[str]:
    texto_low = texto.lower()
    encontrados = []
    for clave, nombre in CULTIVOS_EN_PRODUCTO.items():
        if clave in texto_low and nombre not in encontrados:
            encontrados.append(nombre)
    return encontrados


def parsear_tabla_intervencion_obligatoria(soup: BeautifulSoup, debug: bool = False) -> list[dict]:
    """
    Tabla "LISTADO DE PAÍSES QUE REQUIEREN INTERVENCIÓN OBLIGATORIA DE SENASA":
    dos columnas, País | Producto. Se arma un documento por fila.
    """
    tabla = soup.find("table")
    if tabla is None:
        if debug:
            print("[aviso] no se encontró ninguna <table> en la página.")
        return []

    filas = tabla.find_all("tr")
    items = []
    for fila in filas:
        celdas = fila.find_all(["td", "th"])
        if len(celdas) < 2:
            continue
        pais = celdas[0].get_text(" ", strip=True)
        producto = celdas[1].get_text(" ", strip=True)
        # saltar la fila de encabezado ("País" | "Producto")
        if pais.strip().lower() in ("país", "pais") or producto.strip().lower() == "producto":
            continue
        if not pais or not producto:
            continue
        items.append({"pais": pais, "producto": producto})

    if debug:
        print(f"[tabla] {len(items)} filas país/producto encontradas")
        for it in items[:5]:
            print(f"    {it['pais']} -> {it['producto']}")

    return items


def parsear_paises_normativa_general(soup: BeautifulSoup, debug: bool = False) -> list[dict]:
    """
    Sección "Países que comunican sus requisitos en Normas o Directivas": lista
    de países con, para algunos, un link a la normativa concreta (PDF o sitio
    oficial). Se recorre por <p> (ver PAISES_NORMATIVA_GENERAL_CONOCIDOS para el
    porqué de esa lista) en vez de por clase/id, que no conocemos de antemano.
    """
    inicio_marker = "Países que comunican sus requisitos en Normas o Directivas"
    fin_marker = "Modificación de la Resolución SENASA"

    texto_completo_pagina = soup.get_text("\n", strip=True)
    if inicio_marker not in texto_completo_pagina:
        if debug:
            print(f"[aviso] no se encontró el encabezado '{inicio_marker}' en la página.")
        return []

    resultados = []
    en_seccion = False
    pais_actual = None
    for p in soup.find_all(["p", "h1", "h2", "h3", "h4"]):
        texto_completo = p.get_text(" ", strip=True)
        if not texto_completo:
            continue
        if inicio_marker in texto_completo:
            en_seccion = True
            continue
        if fin_marker in texto_completo:
            break
        if not en_seccion:
            continue

        enlaces = p.find_all("a", href=True)
        texto_propio = texto_completo
        for a in enlaces:
            texto_propio = texto_propio.replace(a.get_text(" ", strip=True), "", 1)
        texto_propio = texto_propio.strip(" :()-")

        if texto_propio:
            # el <p> tiene texto propio más allá de sus links (con o sin link):
            # es un país nuevo sin ambigüedad posible
            pais_actual = texto_completo
        elif len(enlaces) == 1 and _es_nombre_de_pais_conocido(enlaces[0].get_text(" ", strip=True)):
            # <p> de un solo link, y ese link ES el nombre de un país conocido
            # (ej. "Chile"): país nuevo, no un link suelto del país anterior
            pais_actual = enlaces[0].get_text(" ", strip=True)
        # si no entra en ninguno de los dos casos de arriba, es un link suelto
        # (ej. "Instrucciones Normativas", "Buscador de requisitos") y se deja
        # pais_actual como estaba, para que el link se asocie al país anterior

        for a in enlaces:
            resultados.append({
                "pais_o_referencia": pais_actual or a.get_text(" ", strip=True),
                "texto_link": a.get_text(" ", strip=True),
                "url": a["href"],
            })

    if debug:
        print(f"[normativa general] {len(resultados)} referencias con link encontradas")
        for r in resultados[:8]:
            print(f"    {r['pais_o_referencia']}: {r['texto_link']} -> {r['url']}")

    return resultados


def construir_registros(items_tabla: list[dict], fuente_normativa: list[dict]) -> list[dict]:
    """
    Arma los "documentos" finales, con el mismo esquema que espera
    build_chunks_noticias en chunking.py (url, titulo, fecha, fecha_iso, cuerpo),
    más pais_destino y cultivos ya resueltos acá (no hace falta tocar
    PAIS_POR_URL/PRODUCTOS_POR_URL a mano por cada país nuevo). También trae
    documento_id propio: todos estos registros comparten la MISMA url real (es
    una sola página), así que hace falta un id distinto por registro para que
    build_chunks_noticias no les arme el mismo chunk_id a todos (bug real,
    encontrado al probar la integración completa el 28/09/2026).
    """
    registros = []

    for it in items_tabla:
        pais, producto = it["pais"], it["producto"]
        cultivos = _detectar_cultivos_en_texto(producto)
        cuerpo = (
            f"SENASA exige intervención y certificación fitosanitaria obligatoria para "
            f"exportar a {pais.title()} los siguientes productos: {producto}. "
            f"{BASE_LEGAL}"
        )
        registros.append({
            "url": URL,
            "documento_id": f"{URL}#{re.sub(r'[^a-z0-9]+', '-', pais.lower()).strip('-')}",
            "titulo": f"Requisitos de intervención de SENASA para exportar a {pais.title()}",
            "fecha": None,
            "fecha_iso": None,
            "cuerpo": cuerpo,
            "anexos_pdf": [],
            "pais_destino": pais.title(),
            "cultivos": cultivos,
        })

    for i, r in enumerate(fuente_normativa):
        pais = r["pais_o_referencia"]
        cuerpo = (
            f"{pais}: los requisitos fitosanitarios para exportar desde Argentina se "
            f"comunican a través de normativa general del país importador ({r['texto_link']}), "
            f"no de un protocolo bilateral negociado puntualmente con SENASA. "
            f"Referencia: {r['url']}"
        )
        registros.append({
            "url": r["url"] if r["url"].startswith("http") else URL,
            "documento_id": f"{URL}#normativa-{i}",
            "titulo": f"Normativa fitosanitaria general aplicable — {pais}",
            "fecha": None,
            "fecha_iso": None,
            "cuerpo": cuerpo,
            "anexos_pdf": [],
            "pais_destino": pais.title(),
            "cultivos": [],
        })

    return registros


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="../data/raw/onpf_index.json")
    parser.add_argument("--debug", action="store_true", help="Imprime en detalle lo que se encontró en cada sección, para revisar antes de confiar en el resultado.")
    args, _unknown = parser.parse_known_args()

    try:
        SCRIPT_DIR = Path(__file__).parent
    except NameError:
        SCRIPT_DIR = Path.cwd()

    print(f"[bajando] {URL}")
    html = fetch_html(URL)
    soup = BeautifulSoup(html, "html.parser")

    items_tabla = parsear_tabla_intervencion_obligatoria(soup, debug=args.debug)
    fuente_normativa = parsear_paises_normativa_general(soup, debug=args.debug)

    if not items_tabla:
        print(
            "[ALERTA] No se encontró ninguna fila país/producto en la tabla. "
            "La página puede haber cambiado de estructura -- correr con --debug "
            "y revisar a mano antes de seguir."
        )

    registros = construir_registros(items_tabla, fuente_normativa)

    out_path = SCRIPT_DIR / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(registros, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(registros)} registros ({len(items_tabla)} de la tabla + {len(fuente_normativa)} de normativa general). Guardado en: {out_path.resolve()}")


if __name__ == "__main__":
    main()
