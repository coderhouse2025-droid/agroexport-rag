
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

from bs4 import BeautifulSoup, NavigableString

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
    # Lista ampliada el 03/10/2026 después de la primera corrida real contra el
    # sitio: la sección es mucho más grande de lo que parecía al bajar la
    # página a mano la primera vez (tiene, además de la lista chica de "Normas
    # o Directivas", otra sección bastante más grande, "Permisos de
    # importación", con más de 25 países). Con la lista corta original, los
    # países que no estaban se agrupaban mal bajo el último país SÍ reconocido
    # (ej. varios quedaron pegados a "Argelia" o "Puerto Rico" por descarte).
    # Si al revisar onpf_index.json aparece un país agrupado con otro que no
    # tiene nada que ver, probablemente sea porque falta en esta lista.
    "argelia": "Argelia",
    "australia": "Australia",
    "azerbaijan": "Azerbaiyán",
    "azerbaiyán": "Azerbaiyán",
    "bangladesh": "Bangladesh",
    "barbados": "Barbados",
    "bolivia": "Bolivia",
    "brasil": "Brasil",
    "canadá": "Canadá",
    "canada": "Canadá",
    "china": "China",
    "colombia": "Colombia",
    "costa de marfil": "Costa de Marfil",
    "costa rica": "Costa Rica",
    "ecuador": "Ecuador",
    "emiratos árabes unidos": "Emiratos Árabes Unidos",
    "emiratos arabes unidos": "Emiratos Árabes Unidos",
    "guatemala": "Guatemala",
    "méxico": "México",
    "mexico": "México",
    "mozambique": "Mozambique",
    "myanmar": "Myanmar",
    "nueva zelanda": "Nueva Zelanda",
    "omán": "Omán",
    "oman": "Omán",
    "paraguay": "Paraguay",
    "perú": "Perú",
    "peru": "Perú",
    "república dominicana": "República Dominicana",
    "republica dominicana": "República Dominicana",
    "sudáfrica": "Sudáfrica",
    "sudafrica": "Sudáfrica",
    "trinidad y tobago": "Trinidad y Tobago",
    "uruguay": "Uruguay",
    "chile": "Chile",
    "india": "India",
    "indonesia": "Indonesia",
    "israel": "Israel",
    "marruecos": "Marruecos",
    "montenegro": "Montenegro",
    "panamá": "Panamá",
    "panama": "Panamá",
    "serbia": "Serbia",
    "singapur": "Singapur",
    "turquía": "Turquía",
    "turquia": "Turquía",
    "unión europea": "Unión Europea",
    "union europea": "Unión Europea",
    "países miembros de la unión europea": "Unión Europea",
    "unión económica euroasiática": "Unión Económica Euroasiática",
    "union economica euroasiatica": "Unión Económica Euroasiática",
    "países miembros de la unión económica euroasiática": "Unión Económica Euroasiática",
    "estados unidos": "Estados Unidos",
    "puerto rico": "Puerto Rico",
}

# Link genérico de ayuda que aparece suelto en medio/al final de la lista
# (no es específico de ningún país) -- confirmado en dos corridas reales con
# la misma URL exacta, así que se descarta por URL en vez de por posición.
URL_GENERICA_A_DESCARTAR = "https://aps3.senasa.gov.ar/ReglamentacionesPOV/faces/pages/publicPages/consultaPublicaDisposiciones.jsp"


def _ultimo_pais_conocido_en(texto: str) -> str | None:
    """Busca, dentro de un fragmento de texto, cuál de los países conocidos
    aparece más cerca del final (el más relevante para lo que viene después,
    ej. un link). Hace falta porque varios países pueden caer en el mismo
    fragmento de texto corrido (ej. "Marruecos Montenegro Panamá")."""
    texto_low = texto.lower()
    mejor_nombre, mejor_pos = None, -1
    for clave, nombre in PAISES_NORMATIVA_GENERAL_CONOCIDOS.items():
        pos = texto_low.rfind(clave)
        if pos > mejor_pos:
            mejor_pos, mejor_nombre = pos, nombre
    return mejor_nombre


def _es_nombre_de_pais_conocido(texto: str) -> bool:
    # antes exigía coincidencia EXACTA con el texto completo del link, y fallaba
    # con casos reales como "Sudáfrica (sólo artículos reglamentados según el
    # Acta N° 36/1983)" -- el nombre del país está ahí, pero no es todo el
    # texto. Se unifica con _ultimo_pais_conocido_en, que busca por substring.
    return _ultimo_pais_conocido_en(texto) is not None


def _nombre_pais_normalizado(texto: str) -> str:
    return _ultimo_pais_conocido_en(texto) or texto.strip()


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
    oficial).

    Reescrita el 03/10/2026 después de la primera corrida contra el sitio real:
    la versión anterior asumía un <p> por país, pero la página real trae TODOS
    los países y links de esta sección mezclados en un solo bloque de texto
    corrido (ej. "...Chile Buscador de requisitos India Plant Quarantine...",
    todo junto, sin separación clara por país). Este parser procesa el
    contenido de ese bloque en el orden en que aparece (texto y links
    intercalados), y usa PAISES_NORMATIVA_GENERAL_CONOCIDOS para decidir, en
    cada fragmento de texto plano, cuál es el país más reciente mencionado
    (ver _ultimo_pais_conocido_en) y, en cada link, si el link ES un nombre de
    país (ej. "Chile") o un documento asociado al país vigente hasta ese punto
    (ej. "Instrucciones Normativas").
    """
    inicio_marker = "Países que comunican sus requisitos en Normas o Directivas"
    fin_marker = "Modificación de la Resolución SENASA"

    texto_completo_pagina = soup.get_text("\n", strip=True)
    if inicio_marker not in texto_completo_pagina:
        if debug:
            print(f"[aviso] no se encontró el encabezado '{inicio_marker}' en la página.")
        return []

    # 1) ubicar el/los bloque(s) de contenido de la sección: cualquier elemento
    #    de nivel bloque que caiga entre el encabezado de inicio y el de fin.
    #    No se asume más de un país por bloque (ver docstring).
    candidatos = []
    en_seccion = False
    for el in soup.find_all(["p", "div", "li", "h1", "h2", "h3", "h4"]):
        texto_el = el.get_text(" ", strip=True)
        if not texto_el:
            continue
        if inicio_marker in texto_el:
            en_seccion = True
            continue
        if not en_seccion:
            continue
        if fin_marker in texto_el:
            break
        candidatos.append(el)

    # 2) descartar un elemento si ya está CONTENIDO dentro de otro candidato (ej.
    #    un <div> y el <p> que tiene adentro): si no, se procesaría el mismo
    #    contenido dos veces.
    bloques = []
    for el in candidatos:
        if any(el in otro.descendants for otro in bloques):
            continue
        bloques.append(el)

    # 3) recorrer el .contents (hijos directos, en orden) de cada bloque: texto
    #    plano actualiza el país "actual"; un <a> se asocia al país actual, o
    #    pasa a ser el país nuevo si su propio texto es un nombre de país
    #    conocido. pais_actual se mantiene entre bloques (por si un país queda
    #    partido entre dos elementos consecutivos).
    resultados = []
    pais_actual = None
    for bloque in bloques:
        for nodo in bloque.contents:
            if isinstance(nodo, NavigableString):
                encontrado = _ultimo_pais_conocido_en(str(nodo))
                if encontrado:
                    pais_actual = encontrado
                continue
            if nodo.name == "a" and nodo.get("href"):
                texto_link = nodo.get_text(" ", strip=True)
                if not texto_link or nodo["href"] == URL_GENERICA_A_DESCARTAR:
                    continue
                if _es_nombre_de_pais_conocido(texto_link):
                    pais_actual = _nombre_pais_normalizado(texto_link)
                if pais_actual is None:
                    # link suelto antes de que aparezca cualquier país conocido
                    # (ej. un link de ayuda general al principio de la sección,
                    # visto en la corrida real del 03/10/2026: "Consulta de
                    # Disposiciones de Ingreso") -- no hay país al que asociarlo,
                    # se descarta en vez de generar un registro sin sentido
                    continue
                resultados.append({
                    "pais_o_referencia": pais_actual,
                    "texto_link": texto_link,
                    "url": nodo["href"],
                })
            else:
                # otro tag inline (<strong>, <span>, <br>...): puede traer un
                # nombre de país en texto plano dentro (ej. en negrita)
                texto_nodo = nodo.get_text(" ", strip=True)
                if texto_nodo:
                    encontrado = _ultimo_pais_conocido_en(texto_nodo)
                    if encontrado:
                        pais_actual = encontrado

    if debug:
        print(f"[normativa general] {len(resultados)} referencias con link encontradas")
        for r in resultados:
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
