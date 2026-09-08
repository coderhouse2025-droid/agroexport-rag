"""
Agrega 2 documentos genéricos (no específicos de un país) al índice de
noticias/comunicados, encontrados durante la investigación de cobertura
por país del 06-07/09/2026: no existe protocolo bilateral de granos
público para Brasil/UE/India/Japón (a diferencia de China) -- son destinos
sin protocolo negociado aparte, no un hueco de scraping sin resolver.

En cambio, sí encontramos 2 documentos de referencia general que hoy el
corpus no tiene: el proceso de habilitación como exportador de granos
(sin importar destino) y la lista oficial de qué países piden permiso de
importación vs cuáles se rigen por normas generales, incluyendo una tabla
con países que exigen intervención de SENASA para subproductos de granos
(harina/pellets de soja, girasol, maíz) más allá de China.

El texto de "cuerpo" en ambos casos fue extraído vía fetch directo de la
fuente oficial (confirmado 07/09/2026), no generado ni resumido.

Uso (desde la carpeta scraper/, junto a argentina_noticias.py):
    python agregar_noticias_genericas.py
"""
import json
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    SCRIPT_DIR = Path.cwd()

INDEX_PATH = SCRIPT_DIR / "../data/raw/argentina_noticias_index.json"

INSTRUCTIVO_EXPORTADORES = """Inscripciones.
Algunos trámites son generales para todas las exportaciones agroalimentarias y otros son específicos para distintos productos y subproductos.
El futuro exportador debe inscribir su empresa en la AFIP. Para inscribirse deberá presentar su CUIT y registrar un CBU, el cual le servirá para acceder a los reintegros o pagar impuestos de exportación.
El SENASA es el ente que fiscaliza lo concerniente a la sanidad de los productos que se quieren vender tanto en el mercado interno como en el externo. Para ser habilitado, el exportador debe inscribirse como productor revendedor de cereales. No se puede operar sin dicha habilitación, la cual debe renovarse anualmente.
Entre la documentación a gestionar en el SENASA se detallan dos muy importantes: La primera es el Certificado Fitosanitario, que es obligatorio que sea extendido por el SENASA. Para que la mercadería pueda ser exportada conforme a normas vigentes de sanidad en el comercio internacional, se debe realizar el control fitosanitario que origina la remisión de dicho certificado; el mismo se efectúa en puertos, estaciones portuarias internacionales y pasos fronterizos.
El segundo es la Certificación Argentina de Calidad sobre los productos que exporta. En este caso el Exportador puede obtener los servicios de controladores privados o del SENASA.
El SENASA participa también en controles de bodega, seguimiento de trazabilidad en orgánicos, etc.
El Exportador debe contar con una cuenta bancaria para operar y debe cumplir con los requisitos que exige el Banco Central, básicamente operaciones a través de un banco, por intermedio del cual deberá ingresar el monto de las divisas que declaró por la exportación realizada.
Otra de las tareas importantes que realizan los bancos está relacionada con el asesoramiento sobre las diferentes formas de pago internacionales y canales que necesita el exportador para concretar el dinero de la venta: Carta de Crédito, Orden de Pago o Transferencia, según el grado de confianza con el importador extranjero.
Además de las respectivas registraciones en AFIP y SENASA, la empresa que quiera empezar a exportar granos debe registrarse en el Registro Único de la Cadena Agroalimentaria (RUCA).
El futuro exportador también debe contar con un Despachante de Aduana, importante en temas como el transporte de las mercaderías hasta el puerto de embarque, la contratación de bodegas, fletes y seguros. Éste además puede asesorar en Regímenes de Reintegros, Derechos de Exportación y de Importación, casos donde se exime el IVA y Posiciones Arancelarias, entre otros temas, incluido el Nomenclador Común del Mercosur.
En caso que el productor de granos no sea exportador, debe contratar los servicios de un "broker" (cobra comisión por venta) o un "trader" (adquiere la mercadería para revenderla). La Factura de exportación se emitirá siempre bajo la letra "E".
El exportador debe poseer el mayor conocimiento del mercado donde quiere vender sus productos, teniendo en cuenta que hay muchos países que imponen barreras de entrada (arancelarias y/o para-arancelarias, licencias, cuotas, restricciones sanitarias y fitosanitarias, etc.) a los productos extranjeros.
El futuro exportador cuenta con herramientas del sector público (Embajadas en el exterior, Agencia Argentina de Inversiones y Comercio Internacional) y del sector privado (Programa "primera exportación").

Documentos necesarios.
1- Factura Proforma (describe términos y alcances de la operación).
2- Certificado de Origen (certifica el origen de las mercaderías del país de exportación).
3- Conocimiento de Embarque (transporte marítimo, representa la propiedad de la mercadería).
4- Factura Comercial (emitida por el exportador, debe llevar la letra "E").
5- Hoja de Ruta (cargas terrestres, señala los lugares por donde transita el medio de transporte con destino a la aduana de salida).
6- Manifiesto Internacional de cargas (cargas terrestres, datos del medio de transporte).
7- Multinota AFIP (planilla utilizada por los despachantes ante la aduana).
8- Carta de Porte (cargas terrestres, concede la titularidad de la mercadería).
9- Guía Aérea (envíos aéreos, asigna la titularidad de la mercadería).
10- Lista de Empaque (contenido, peso bruto y neto de la mercadería).

Otro elemento a tener en cuenta son los Incoterms: reglas internacionales que determinan el alcance de las cláusulas comerciales de un contrato de compraventa. De un total de 13 Incoterms, los usados con mayor frecuencia son FOB y CIF.

Declaraciones Juradas de Ventas al Exterior (DJVE).
Por la Resolución 171-E/2017 se establece que la SUBSECRETARÍA DE MERCADOS AGROPECUARIOS de la SECRETARÍA DE MERCADOS AGROINDUSTRIALES del MINISTERIO DE AGROINDUSTRIA entenderá en el procedimiento para el registro de las "DJVE" a las que se refiere la Ley N° 21.453 y su aclaratoria N° 26.351, y se extiende a TRESCIENTOS SESENTA (360) DIAS CORRIDOS el plazo de validez de las "DJVE" para que el exportador oficialice las destinaciones de exportación para consumo ante la AFIP.
Trámites: a) Presentación DDJJ Rectificación Destino de Ventas al Exterior; b) Solicitudes aprobadas; c) Solicitudes denegadas.
Consultas: Teléfono (011) 4349-1590 | Mail: djve-granos@magyp.gob.ar"""

ONPF_DOCUMENTACION = """Estos listados fueron confeccionados con la información que actualmente posee la Dirección de Certificación Fitosanitaria de SENASA. Se actualiza periódicamente de acuerdo a la dinámica en los cambios de los requisitos fitosanitarios de los países importadores.

PAÍSES QUE EMITEN PERMISOS DE IMPORTACIÓN O DOCUMENTO EQUIVALENTE
Para el inicio del trámite de exportación, el exportador/despachante deberá presentar en la Oficina Senasa una copia del permiso de importación para la exportación de productos de categoría de riesgo 2 a 5 (COSAVE). Para productos de categoría de riesgo 0 y 1 (COSAVE) solamente cuando sea requerido por el país de destino.
Entre los países que emiten Permisos de Importación o Autorizaciones Fitosanitarias de Importación para cada operación específica: Angola, Argelia, Australia, Azerbaiyán, Bahrein, Bangladesh, Barbados, Belice, Bolivia, Brasil, Brunei, Burundi, Camerún, Canadá, China, Colombia, Costa de Marfil, Costa Rica, Cuba, Ecuador, Egipto, El Salvador, Estados Unidos (excepto granos), Emiratos Árabes Unidos, Etiopía, Filipinas, Ghana, Guatemala, Guyana, Honduras, Islas Salomón, Jamaica, Jordania, Kenia, Kuwait, Líbano, Madagascar, Malasia, Malawi, Mauricio, México, Mozambique, Myanmar, Namibia, Nepal, Nicaragua, Nigeria, Nueva Zelanda, Omán, Pakistán, Paraguay, Perú, República Dominicana, Rwanda, Senegal, Sierra Leona, Siria, Somalia, Sudáfrica, Sudán, Surinam, Tailandia, Tanzania, Trinidad y Tobago, Uganda, Uruguay, Venezuela, Zambia, Zimbabwe.

PAÍSES QUE COMUNICAN SUS REQUISITOS EN NORMAS O DIRECTIVAS
Para estos casos, el exportador/despachante NO deberá presentar copia de dichos documentos en la Oficina Senasa para el inicio del trámite de exportación, ya que la Coordinación General de certificación fitosanitaria ya cuenta con ellos. El despachante o exportador debe verificar la vigencia consultando directamente al importador o el SIG-REGPOV (Consulta de Disposiciones de Ingreso).
Publican requisitos de carácter general (no específicos por operación): Argelia (excepto fruta fresca), Brasil (excepto material de propagación, vía Instrucciones Normativas), Chile, India (Plant Quarantine (Regulation of Import into India) Order, 2003), Indonesia (fruta y plantas vivas), Israel, Marruecos, Montenegro, Panamá, Serbia, Singapur, Turquía, Países miembros de la Unión Europea (Directiva de Sanidad Vegetal 2000/29/EC), Países miembros de la Unión Económica Euroasiática (Decisión N° 157 del Consejo de la UEE).

MODIFICACIÓN DE LA RESOLUCIÓN SENASA N° 260/2014
La Resolución SENASA N° 37/2017 sustituye el Artículo 1° de la Resolución SENASA N° 260/2014: "ARTÍCULO 1°.- Control fitosanitario y de calidad de productos y subproductos de granos. Todos los embarques de productos y subproductos de granos para exportación o reexportación deben ser sometidos al control fitosanitario y de calidad del Servicio Nacional de Sanidad y Calidad Agroalimentaria. Quedan exceptuados de dicho control fitosanitario y de calidad, los aceites, harinas, pellets, expellers y tortas de cereales y oleaginosas, cuando no sea requerido por el país de destino. Sin perjuicio de ello, el usuario interviniente podrá solicitarlo en cualquiera de las operaciones mencionadas."

LISTADO DE PAÍSES QUE REQUIEREN INTERVENCIÓN OBLIGATORIA DE SENASA (productos de Categoría de riesgo 0 y 1 COSAVE) -- se solicita comunicar a Senasa sobre destinos de exportación diferentes a los listados, para los que se posean contratos firmados o futuros negocios, para tramitar oficialmente la consulta al país importador:
Australia: Harina de Soja. Bangladesh: Harina de Soja. Brunei: Harina de Soja. Camerún: Harina de Soja, Torta de Soja. Colombia: Expeller de Soja. República Democrática del Congo (ex Zaire): Harina de Soja. Costa de Marfil: Harina de Soja. Cuba: todas las harinas, Expeller de Soja, Expeller de Lino, Expeller de Maíz, Torta de Maní, Torta de Soja. Ecuador: Harina de Soja, Torta de Soja, Pellet de Soja. Egipto: Harina de Soja. El Salvador: Harina de Soja. Filipinas: Harina de Soja. Ghana: Harina de Soja. Guatemala: Harina de Soja. Honduras: Texturizado de soja. Irán: Pellet de Soja. Jordania: Harina de Soja. Malasia: Harina de Soja, Expeller de Soja, Expeller de soja molido, Expeller de Maíz, Expeller de Lino, Torta de Soja, Torta de Maní, Pellet de Soja. Mauricio: Harina de Soja. Mozambique: Harina de Soja. Myanmar: Harina de Soja. Nicaragua: Harina de soja. Nigeria: Harina de soja. Nueva Zelanda: Harina de Soja, Pellet de Soja. Pakistán: Harina de Soja. Senegal: Harina de Soja. Sudáfrica: Torta de Girasol, Harina de Girasol, Pellet de Girasol."""

nuevos = [
    {
        "url": "https://www.magyp.gob.ar/sitio/areas/ss_mercados_agropecuarios/datos_utiles/_archivos/000009_Instructivo%20para%20Futuros%20Exportadores%20de%20Granos.pdf",
        "titulo": "Instructivo para futuros exportadores de granos",
        "fecha": "2018 (sin fecha exacta de publicación en el documento)",
        "fecha_iso": None,
        "cuerpo": INSTRUCTIVO_EXPORTADORES,
        "anexos_pdf": [],
    },
    {
        "url": "https://www.argentina.gob.ar/senasa/portal-de-certificacion-fitosanitaria-de-exportaci%C3%B3n/documentacion-oficial-de-las-onpf",
        "titulo": "Documentación oficial de las ONPF",
        "fecha": "23 de julio de 2026 (última modificación)",
        "fecha_iso": "2026-07-23",
        "cuerpo": ONPF_DOCUMENTACION,
        "anexos_pdf": [],
    },
]


def main():
    data = json.loads(INDEX_PATH.read_text(encoding="utf-8")) if INDEX_PATH.exists() else []
    urls_existentes = {d["url"] for d in data}
    agregados = 0
    for n in nuevos:
        if n["url"] not in urls_existentes:
            data.append(n)
            agregados += 1
        else:
            print(f"[ya existía, no se duplica] {n['titulo']}")

    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nAgregados: {agregados} | Total en el índice: {len(data)}")
    print(f"Guardado en: {INDEX_PATH.resolve()}")


if __name__ == "__main__":
    main()
