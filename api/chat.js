// api/chat.js
// Función serverless (Vercel): pipeline RAG completo para Ceres AI.
//
// 1. Recibe la pregunta del usuario + historial de la conversación.
// 2. Busca los chunks más relevantes en Pinecone (retrieval semántico,
//    inferencia integrada con llama-text-embed-v2 -- mismo modelo usado al
//    indexar, ver indexer/index_pinecone.py).
// 3. Arma el prompt con ese contexto + instrucciones de citado.
// 4. Llama a Groq (openai/gpt-oss-120b) con streaming.
// 5. Devuelve, además del texto, la lista de fuentes citables (para el
//    "sello" que se muestra debajo de cada respuesta en el frontend).
//
// Las API keys viven solo acá (variables de entorno del lado del servidor),
// nunca en el bundle del cliente.

const PINECONE_INDEX = process.env.PINECONE_INDEX || "agroexport-granos";
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || "default";
const GROQ_MODEL = "openai/gpt-oss-120b";
const TOP_K = 8; // subido de 6 a 8 el 10/09/2026: los scores de este corpus rondan 0.33-0.47
// en general (no hay separación fuerte entre chunks relevantes e irrelevantes), así que un
// candidato relevante pero no "top 6" para una pregunta con fraseo natural se estaba quedando
// afuera -- caso detectado con "cuánto pago de retenciones por exportar soja".
const MAX_PREGUNTA_CHARS = 500;
const MAX_HISTORIAL_MENSAJES = 8; // últimos N mensajes del historial, para no inflar el prompt
const RESUMEN_MAX_TOKENS = 200; // gpt-oss gasta tokens en razonamiento interno antes de la respuesta final -- 40 no le alcanzaba y dejaba "content" vacío

// Búsquedas dirigidas (19/09/2026). La búsqueda semántica sola no recuperó dos cosas que sí están
// indexadas: el registro de alícuotas de retenciones (para "¿qué dice el decreto 423/2026?") y la
// noticia ePhyto de Brasil (para "trigo a Brasil"). Cuando la pregunta lo amerita se hace una
// segunda consulta a Pinecone y se suma al contexto (ver buscarContexto).
// El registro de alícuotas (scraper/agregar_retenciones_manual.py) se identifica por su url. Una
// búsqueda semántica por título NO alcanzó (20/09/2026, "¿qué dice el decreto 423/2026?"): el título
// se parece más a los propios decretos que al registro, y devolvía los decretos. Con filtro por
// url se traen sus chunks sí o sí.
const URL_REGISTRO_RETENCIONES = "https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/426351/norma.htm";
const RE_RETENCIONES = /retenci[oó]n|retenciones|al[ií]cuota|derechos?\s+de\s+exportaci[oó]n|\bDEX\b|decreto\s*(?:n[°º.]*\s*)?(?:423|877)/i;
// Países que tienen documentos con pais_destino cargado (ver PAIS_POR_URL en indexer/chunking.py).
// Si se suman países al corpus, agregarlos acá.
const PAISES_CON_DATOS = [
  { re: /\bbrasil\b/i, valor: "Brasil" },
  { re: /\bchina\b/i, valor: "China" },
];
// Puerta de alcance (20/09/2026): "¿Cómo registro una DDJJ de Ganancias?" seguía recibiendo una
// respuesta sobre el formulario F. 2669 (registro de contratos de exportación) presentada como si
// fuera la declaración de Ganancias, pese a la regla del prompt. Para temas impositivos generales
// sin relación con exportación se responde directo, sin llamar al modelo.
const RE_IMPUESTO_GENERAL = /\b(ganancias|iva|monotributo|ingresos\s+brutos|bienes\s+personales)\b/i;
const RE_CONTEXTO_EXPORTACION = /exporta|dj[vj]e|contrato|retenci|derechos?\s+de\s+exportaci|aduan|senasa|fitosanit|grano|soja|ma[ií]z|trigo|girasol/i;
const MENSAJE_FUERA_DE_ALCANCE =
  "Esa consulta está fuera de lo que cubro. Ceres AI responde sobre requisitos fitosanitarios (SENASA), trámites aduaneros y de registro de exportación (ARCA) y derechos de exportación (retenciones) de granos y oleaginosas. Los temas impositivos generales, como las declaraciones juradas de Ganancias o IVA, no están en mi base: consultalos directamente en ARCA o con tu contador.";
const RESUMEN_FUERA_DE_ALCANCE = "Consulta fuera del alcance de Ceres AI (temas impositivos generales).";
const MAX_DIRIGIDOS = 4; // tope de chunks que suman las búsquedas dirigidas, para no inflar el prompt

// Patrón de respuestas del tipo "no tengo información": se usa solo como respaldo cuando el
// modelo no devuelve el marcador [[FUENTES: ...]] (ver crearFiltroSalida).
const SIN_INFO_PATRON = /no dispongo de informaci[oó]n|no tengo informaci[oó]n|no cuento con informaci[oó]n|no se incluye informaci[oó]n|no se encuentra informaci[oó]n|no hay informaci[oó]n|no consta\b|no se especifica|no se detalla/i;

// --- Rate limiting simple, en memoria (por instancia serverless) ---
// Nota honesta: igual que en Norma-AR, esto no es una garantía global si el
// tráfico crece mucho (cada instancia fría tiene su propio contador) -- para
// producción con más tráfico conviene migrar a Upstash/Vercel KV.
const intentosPorIp = new Map();
const RATE_LIMIT_VENTANA_MS = 60_000;
const RATE_LIMIT_MAX = 15;

function rateLimitOk(ip) {
  const ahora = Date.now();
  const registro = intentosPorIp.get(ip);
  if (!registro || ahora - registro.inicio > RATE_LIMIT_VENTANA_MS) {
    intentosPorIp.set(ip, { inicio: ahora, cuenta: 1 });
    return true;
  }
  if (registro.cuenta >= RATE_LIMIT_MAX) return false;
  registro.cuenta += 1;
  return true;
}

async function consultarPinecone(texto, topK, filtro) {
  const apiKey = process.env.PINECONE_API_KEY;
  // .replace() saca un "https://" (o "http://") por si se pegó por error en la
  // variable de entorno de Vercel -- sin esto, la URL de abajo queda
  // "https://https://..." y el fetch tira un TypeError sin mensaje claro
  // (detectado 17/09/2026 al migrar a una cuenta nueva de Pinecone).
  const host = (process.env.PINECONE_HOST || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host || !apiKey) {
    throw new Error(
      `Falta configuración de Pinecone: PINECONE_HOST=${host ? "OK" : "vacío"}, PINECONE_API_KEY=${apiKey ? "OK" : "vacío"}`
    );
  }

  const query = { inputs: { text: texto }, top_k: topK };
  if (filtro) query.filter = filtro;

  const resp = await fetch(
    `https://${host}/records/namespaces/${PINECONE_NAMESPACE}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": apiKey,
        "X-Pinecone-Api-Version": "2025-10",
      },
      body: JSON.stringify({ query }),
    }
  );

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`Pinecone respondió ${resp.status}: ${detalle}`);
  }

  const data = await resp.json();
  const hits = data?.result?.hits || [];

  return hits.map((hit) => ({
    id: hit._id,
    documentoId: hit.fields?.documento_id || hit.fields?.url || hit._id,
    score: hit._score,
    texto: hit.fields?.texto || "",
    titulo: hit.fields?.titulo || "",
    fuente: hit.fields?.fuente || "",
    tipoNorma: hit.fields?.tipo_norma || null,
    organismoEmisor: hit.fields?.organismo_emisor || null,
    numeroNorma: hit.fields?.numero_norma || null,
    anio: hit.fields?.anio || null,
    fechaIso: hit.fields?.fecha_iso || null, // YYYY-MM-DD cuando se conoce; se pasa al prompt para que el modelo detecte plazos vencidos
    paisDestino: hit.fields?.pais_destino || null,
    cultivos: hit.fields?.cultivos || [],
    url: hit.fields?.url || null,
    vigente: hit.fields?.vigente ?? null, // false = derogada (evidencia encontrada en el corpus); null = no verificado, NO asumir vigente
    derogadaPorTitulo: hit.fields?.derogada_por_titulo || null,
    evidenciaDerogacion: hit.fields?.evidencia_derogacion || null,
  }));
}

async function buscarContextoDirigido(pregunta) {
  // Búsquedas dirigidas: si fallan no rompen la consulta (se loguea y se sigue con la principal).
  const dirigidas = [];
  if (RE_RETENCIONES.test(pregunta)) {
    dirigidas.push({ nombre: "retenciones", texto: pregunta, topK: 3, filtro: { url: { $eq: URL_REGISTRO_RETENCIONES } } });
  }
  for (const p of PAISES_CON_DATOS) {
    if (p.re.test(pregunta)) {
      dirigidas.push({ nombre: `pais:${p.valor}`, texto: pregunta, topK: 3, filtro: { pais_destino: { $eq: p.valor } } });
    }
  }

  const [principal, ...resultadosDirigidos] = await Promise.all([
    consultarPinecone(pregunta, TOP_K),
    ...dirigidas.map((d) =>
      consultarPinecone(d.texto, d.topK, d.filtro).catch((err) => {
        console.error(`[busqueda-dirigida:${d.nombre}] falló, se sigue sin ella:`, err);
        return [];
      })
    ),
  ]);

  // Los resultados dirigidos van primero (son los que la pregunta pide explícitamente).
  const vistos = new Set();
  const contexto = [];
  let sumadosDirigidos = 0;
  const idsRetenciones = new Set(
    (resultadosDirigidos[dirigidas.findIndex((d) => d.nombre === "retenciones")] || []).map((h) => h.id)
  );
  for (const h of resultadosDirigidos.flat()) {
    if (vistos.has(h.id) || sumadosDirigidos >= MAX_DIRIGIDOS) continue;
    vistos.add(h.id);
    contexto.push(h);
    sumadosDirigidos += 1;
  }
  for (const h of principal) {
    if (vistos.has(h.id)) continue;
    vistos.add(h.id);
    contexto.push(h);
  }
  if (dirigidas.length) {
    console.log(`[busqueda-dirigida] ${dirigidas.map((d) => d.nombre).join(", ")} -> +${sumadosDirigidos} chunks`);
  }
  return { contexto, idsRetenciones };
}

function limpiarTexto(texto) {
  return texto
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ") // cualquier otra etiqueta HTML suelta
    .replace(/\[([^\]]+)\]\(?[^)]*\)?/g, "$1") // [email] o [texto](link) -> solo el texto
    .replace(/\|-+\|[-|]*\|?/g, " ") // fila separadora de tabla markdown: |---|---|
    .replace(/\|/g, " — ") // pipes de tabla -> separador de prosa
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Limpieza para cada chunk (delta) de la RESPUESTA del modelo, no del
// contexto de entrada. `limpiarTexto` de arriba solo se aplica a los
// fragmentos que se mandan como contexto en el prompt -- pero el modelo a
// veces igual genera una tabla markdown en su respuesta pese a la
// instrucción del prompt de no hacerlo, y esa respuesta se streamea directo
// al cliente sin pasar por ningún filtro (bug detectado 07/09/2026, ej.
// "| Se acepta electrónicamente..." colándose en el texto final).
// Solo hacemos el reemplazo de un solo carácter ("|" -> " — "), que es
// seguro de aplicar delta por delta sin importar dónde caigan los cortes de
// chunk del streaming (un carácter suelto no se puede partir a la mitad).
// No replicamos acá la regex de fila separadora completa (|-+|-+|) porque
// esa sí podría quedar partida entre dos deltas distintos y no matchear.
function limpiarDelta(delta) {
  return delta.replace(/\|/g, " — ");
}

// Resumen corto de la consulta, para el panel "Resumen de la consulta" del
// frontend. Llamada aparte, sin streaming y con pocos tokens -- barata y
// rápida (no bloquea la respuesta principal, se genera después de que esta
// ya terminó). Si falla, no rompe nada: el frontend cae de vuelta a mostrar
// la pregunta tal cual la escribió el usuario (ver ResumenConsulta en App.jsx).
async function generarResumen(pregunta, respuesta) {
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Resumí la siguiente consulta y respuesta en UNA sola oración corta (máximo 20 palabras), en español rioplatense, en tercera persona (ej. \"Requisitos fitosanitarios para exportar soja a China\"). Sin comillas, sin punto final innecesario, solo la oración.",
          },
          {
            role: "user",
            content: `Pregunta: ${pregunta}\n\nRespuesta: ${respuesta.slice(0, 800)}`,
          },
        ],
        temperature: 0.2,
        max_completion_tokens: RESUMEN_MAX_TOKENS,
        reasoning_effort: "low",
        stream: false,
      }),
    });
    if (!resp.ok) {
      const detalle = await resp.text();
      console.error(`[resumen] Groq respondió ${resp.status}: ${detalle}`);
      return null;
    }
    const data = await resp.json();
    const texto = data?.choices?.[0]?.message?.content?.trim();
    if (!texto) {
      console.error("[resumen] respuesta OK pero sin texto útil, data cruda:", JSON.stringify(data).slice(0, 500));
    }
    return texto || null;
  } catch (err) {
    console.error("[resumen] falló, se omite (no afecta la respuesta principal):", err);
    return null;
  }
}

// --- Marcador de fuentes ---
// El modelo termina la respuesta con una línea [[FUENTES: S1, S3]] que dice en qué fuentes se
// apoyó. El servidor la saca del texto que ve el usuario y la usa para armar los sellos: así los
// sellos son las fuentes usadas, no todo lo que devolvió la búsqueda (antes se mostraban
// resoluciones de 1994-2004 sin relación con la pregunta). También se borran los códigos S1, S2...
// si el modelo se los deja escapar dentro del texto (pasó con "Fragmento 4" el 19/09/2026).
// Se retiene una cola de texto sin emitir para que un código o el marcador partidos entre dos
// deltas del streaming no lleguen nunca al usuario.
const COLA_RETENIDA = 40;
const RE_CODIGOS_EN_TEXTO = /\s*[(\[]\s*(?:fuentes?\s*:?\s*)?S\d{1,2}(?:\s*(?:,|;|y|e|-|–)\s*S\d{1,2})*\s*[)\]]/gi;
const quitarCodigos = (t) => t.replace(RE_CODIGOS_EN_TEXTO, "");

function crearFiltroSalida() {
  let buf = "";
  let marcador = "";
  let enMarcador = false;
  return {
    push(delta) {
      if (enMarcador) {
        marcador += delta;
        return "";
      }
      buf += delta;
      const i = buf.indexOf("[[FUENTES");
      if (i >= 0) {
        const antes = quitarCodigos(buf.slice(0, i)).replace(/\s+$/, "");
        marcador = buf.slice(i);
        buf = "";
        enMarcador = true;
        return antes;
      }
      const limpio = quitarCodigos(buf);
      if (limpio.length <= COLA_RETENIDA) {
        buf = limpio;
        return "";
      }
      const emitir = limpio.slice(0, limpio.length - COLA_RETENIDA);
      buf = limpio.slice(limpio.length - COLA_RETENIDA);
      return emitir;
    },
    fin() {
      if (enMarcador) return "";
      // si la respuesta se cortó justo en medio del marcador ("[[FUEN"), no dejarlo pasar
      const base = quitarCodigos(buf);
      const sinParcial = base.replace(/\[{1,2}(?:F(?:U(?:E(?:N(?:T(?:E(?:S)?)?)?)?)?)?)?$/i, "");
      buf = "";
      return sinParcial !== base ? sinParcial.replace(/\s+$/, "") : base;
    },
    // null = el modelo no puso el marcador (o quedó cortado): se usa el respaldo.
    fuentesDeclaradas() {
      if (!enMarcador) return null;
      const m = marcador.match(/\[\[FUENTES:?\s*([^\]\n]*)/i);
      if (!m) return null;
      if (/ninguna/i.test(m[1])) return [];
      const codigos = (m[1].match(/S\d{1,2}/gi) || []).map((c) => c.toUpperCase());
      return codigos.length ? codigos : null;
    },
  };
}

const MAX_SELLOS = 6;
const SELLOS_RESPALDO = 3;

const FRAGMENTO_MAX_CHARS = 500;

function recortarFragmento(texto) {
  const limpio = (texto || "").trim().replace(/\s+/g, " ");
  if (limpio.length <= FRAGMENTO_MAX_CHARS) return limpio;
  const corte = limpio.slice(0, FRAGMENTO_MAX_CHARS);
  const ultimoEspacio = corte.lastIndexOf(" ");
  return `${corte.slice(0, ultimoEspacio > 0 ? ultimoEspacio : FRAGMENTO_MAX_CHARS)}…`;
}

function elegirFuentes(declaradas, contexto, respuesta) {
  let elegidos;
  if (declaradas) {
    const pedidos = new Set(declaradas);
    elegidos = contexto.filter((_, i) => pedidos.has(`S${i + 1}`));
  } else if (SIN_INFO_PATRON.test(respuesta)) {
    elegidos = [];
  } else {
    // Respaldo: el modelo no puso el marcador. Mostramos solo los mejores por score.
    elegidos = [...contexto].sort((a, b) => b.score - a.score).slice(0, SELLOS_RESPALDO);
  }
  // Varios chunks pueden venir del mismo documento: un solo sello por documento.
  const unicas = [];
  const vistos = new Set();
  for (const c of elegidos) {
    if (vistos.has(c.documentoId)) continue;
    vistos.add(c.documentoId);
    unicas.push({
      titulo: c.titulo,
      tipoNorma: c.tipoNorma,
      organismoEmisor: c.organismoEmisor,
      numeroNorma: c.numeroNorma,
      anio: c.anio,
      fuente: c.fuente,
      url: c.url,
      vigente: c.vigente,
      derogadaPorTitulo: c.derogadaPorTitulo,
      // fragmento de texto citado, para la "ficha de norma" del frontend (clic en un
      // sello). Se corta a 500 caracteres en un límite de palabra para no mandar el
      // chunk entero -- es solo una vista previa, no reemplaza abrir la fuente oficial.
      fragmento: recortarFragmento(c.texto),
    });
    if (unicas.length >= MAX_SELLOS) break;
  }
  return unicas;
}

// Detección en código (no depende de que el modelo "recuerde" no inventar), agregada
// el 26/09/2026: una fuente real lista 5 productos en el título ("granos de cebada,
// trigo, soja, sorgo y maíz") pero solo trae Declaración Jurada de zarandeo para 2
// (cebada y trigo). Ya le prohibimos dos veces en el prompt que invente ese trámite
// para los otros 3 -- una vez de forma general, otra vez prohibiendo puntualmente la
// frase "(según corresponda)" -- y el modelo lo siguió coston con otra frase de
// cobertura distinta ("según el procedimiento de la convocatoria"). Perseguir cada
// frase nueva es un juego perdido; en cambio, esto calcula el hecho una sola vez con
// una expresión regular sobre el propio texto de la fuente, sin hardcodear "maíz" ni
// ningún producto puntual, así generaliza a cualquier fuente con esta misma forma.
const CULTIVOS_RECONOCIDOS = ["soja", "maiz", "trigo", "cebada", "sorgo", "girasol"];
const RE_ZARANDEO_PRODUCTO = /Declaraci[oó]n\s+Jurada\s+de\s+zarandeo\s+de\s+(\p{L}+)/giu;

function normalizarCultivo(palabra) {
  const p = palabra.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // sin tildes
  return p === "maiz" ? "maíz" : p;
}

function detectarZarandeoFaltante(textoFuente) {
  // se le sacan las tildes al texto ANTES de buscar, no solo a lo ya encontrado, porque
  // si no "maíz" (con tilde, como suele venir escrito en las fuentes reales) no matchea
  // contra el patrón "maiz" (sin tilde) -- bug real que apareció al probar esto contra
  // el texto de la fuente de China antes de mandarlo.
  const textoSinTildes = textoFuente.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const mencionados = new Set();
  for (const c of CULTIVOS_RECONOCIDOS) {
    if (new RegExp(`\\b${c}\\b`).test(textoSinTildes)) mencionados.add(normalizarCultivo(c));
  }
  if (mencionados.size < 2) return null; // no es una fuente que hable de varios productos

  const conDJ = new Set();
  let m;
  RE_ZARANDEO_PRODUCTO.lastIndex = 0;
  while ((m = RE_ZARANDEO_PRODUCTO.exec(textoFuente)) !== null) {
    conDJ.add(normalizarCultivo(m[1]));
  }
  if (conDJ.size === 0) return null; // esta fuente no habla de zarandeo para nada

  const sinDJ = [...mencionados].filter((c) => !conDJ.has(c));
  return sinDJ.length ? { conDJ: [...conDJ], sinDJ } : null;
}

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// Detecta plazos del tipo "hasta el 6 de septiembre" dentro del texto de un fragmento y
// devuelve los que ya pasaron respecto de hoy. Si el texto no trae año, se usa el de la
// fecha de publicación del fragmento (fecha_iso). Se hace acá, en código, porque pedirle al
// modelo que compare fechas por su cuenta falló en la prueba del 19/09/2026: listó la
// convocatoria a China (24/08 al 06/09) sin decir que ya había cerrado.
function detectarPlazosVencidos(texto, fechaIso, hoyIso) {
  const encontrados = new Map(); // iso -> texto legible
  const re = /hasta\s+el\s+(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const dia = Number(m[1]);
    const mes = MESES[m[2].toLowerCase()];
    let anio = m[3] ? Number(m[3]) : null;
    if (!anio) {
      if (!fechaIso) continue;
      anio = Number(fechaIso.slice(0, 4));
      const mesPublicacion = Number(fechaIso.slice(5, 7));
      if (mes < mesPublicacion) anio += 1; // publicado en diciembre, plazo "hasta el 15 de enero"
    }
    const iso = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    if (iso < hoyIso) encontrados.set(iso, `${dia} de ${m[2].toLowerCase()} de ${anio}`);
  }
  return [...encontrados].map(([iso, texto]) => ({ iso, texto })).sort((a, b) => a.iso.localeCompare(b.iso));
}

const hoyIsoArgentina = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }); // YYYY-MM-DD
const VENTANA_AVISO_PLAZO_DIAS = 180; // un plazo que cerró hace años (p. ej. el protocolo de 2023) no es un aviso útil

// Aviso fijo al comienzo de la respuesta (20/09/2026): con la aclaración en el prompt, el modelo
// igual dejaba "los plazos ya cerraron" en una nota al final y arrancaba con "debés inscribirte".
// Se muestra solo si la pregunta menciona el país del documento (hoy, China) y el plazo cerró
// hace poco. No se muestra en preguntas de retenciones.
function armarAvisoPlazo(pregunta, contexto, hoyIso) {
  if (RE_RETENCIONES.test(pregunta)) return "";
  let ultimo = null;
  for (const c of contexto) {
    const pais = PAISES_CON_DATOS.find((p) => p.valor === c.paisDestino);
    if (!pais || !pais.re.test(pregunta)) continue;
    for (const p of detectarPlazosVencidos(c.texto, c.fechaIso, hoyIso)) {
      const dias = (Date.parse(hoyIso) - Date.parse(p.iso)) / 86_400_000;
      if (dias <= VENTANA_AVISO_PLAZO_DIAS && (!ultimo || p.iso > ultimo.iso)) ultimo = p;
    }
  }
  return ultimo
    ? `**Importante:** el plazo de inscripción que figura en la normativa para ese destino cerró el ${ultimo.texto}. Para la próxima convocatoria, consultá al SENASA.\n\n`
    : "";
}

function armarPromptSistema(contexto, avisoMostrado = false, codigosRetenciones = []) {
  const hoy = new Date().toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const hoyIso = hoyIsoArgentina();

  const bloques = contexto
    .map((c, i) => {
      const cita = c.numeroNorma
        ? `${[c.tipoNorma, c.organismoEmisor].filter(Boolean).join(" ")} N° ${c.numeroNorma}`
        : c.titulo;
      const avisoDerogacion =
        c.vigente === false
          ? `\n[AVISO: esta norma fue derogada por "${c.derogadaPorTitulo}". No la cites como vigente -- avisale al usuario que está derogada y, si el fragmento derogante también está en el contexto, preferí ese.]`
          : "";
      const notaNoticia = c.fuente === "noticia" && c.fechaIso ? "; \"ahora\" o \"a partir de ahora\" en el texto = esa fecha" : "";
      const fecha = c.fechaIso
        ? ` (publicado: ${c.fechaIso.slice(0, 10)}${notaNoticia})`
        : c.anio
          ? ` (año: ${c.anio})`
          : "";
      const plazos = detectarPlazosVencidos(c.texto, c.fechaIso, hoyIso);
      const avisoPlazo = plazos.length
        ? `\n[AVISO: este texto menciona plazos que YA VENCIERON respecto de hoy (${hoy}): hasta el ${plazos.map((p) => p.texto).join("; hasta el ")}. No lo presentes como abierto: decí que ese plazo ya cerró (con la fecha) y que hay que consultar al SENASA por la próxima convocatoria.]`
        : "";
      const zarandeo = detectarZarandeoFaltante(`${c.titulo} ${c.texto}`);
      const avisoZarandeo = zarandeo
        ? `\n[AVISO: esta fuente SOLO trae Declaración Jurada de zarandeo para: ${zarandeo.conDJ.join(", ")}. Para ${zarandeo.sinDJ.join(", ")} esta fuente NO tiene esa declaración -- si preguntan por uno de esos productos, decí explícitamente que esta fuente no la incluye para ese producto. No la inventes ni la des por hecha "según corresponda" ni con ninguna otra frase parecida.]`
        : "";
      return `[S${i + 1}: ${cita}${fecha}]${avisoDerogacion}${avisoPlazo}${avisoZarandeo}\n${limpiarTexto(c.texto)}`;
    })
    .join("\n\n");

  return `Sos Ceres AI, un asistente que ayuda a exportadores argentinos de granos y oleaginosas (soja, maíz, trigo, girasol y sus subproductos) a entender los requisitos fitosanitarios y aduaneros para exportar. Hoy es ${hoy}.

REGLA PRINCIPAL: SOLO EL CONTEXTO
Respondé SOLO con lo que dicen los fragmentos de documentación oficial que se listan al final. No completes con conocimiento propio: no menciones organismos, sistemas informáticos, reglamentos de otros países, formularios, plazos, cifras ni requisitos que no estén escritos en los fragmentos, aunque los conozcas o te parezcan obvios. Nunca inventes números de resolución, fechas ni requisitos.

Si los fragmentos no alcanzan para responder:
- Si no hay nada relevante, empezá la respuesta con la frase "No tengo información en mi base sobre ..." y explicá en una o dos oraciones qué se consultó.
- Si la cobertura es parcial, contá solo lo que sí está respaldado por los fragmentos, sin usar esa frase, e indicá con claridad qué parte no está cubierta.
- En ambos casos, orientá al usuario a consultar directamente al organismo que corresponde al tema de la pregunta: SENASA si es fitosanitario, ARCA si es aduanero o impositivo. No nombres a los dos si el tema es de uno solo, y no inventes contactos, links ni pasos que no figuren en el contexto.

ALCANCE
Tu base cubre requisitos fitosanitarios (SENASA), trámites aduaneros y de registro de exportación (ARCA) y derechos de exportación (retenciones) de granos y oleaginosas. Si la pregunta es de otro tema (impuestos generales, otros productos, países que no figuran en el contexto), decilo. No reinterpretes la pregunta para que encaje con lo que sí tenés: si el usuario pregunta por X y la base solo tiene algo parecido pero distinto, aclará que no es lo mismo que preguntó y ofrecé lo que sí hay. Ejemplo: si preguntan cómo presentar una declaración jurada de Ganancias y la base solo tiene el registro de contratos de exportación (formulario F. 2669), no lo describas como si fuera la declaración de Ganancias.

GLOSARIO (para interpretar preguntas y fragmentos)
- ARCA: Agencia de Recaudación y Control Aduanero, la ex AFIP. Si un fragmento dice AFIP o Aduana, referite a ARCA (podés aclarar "ex AFIP"). Nunca digas que un trámite se hace en la AFIP.
- SENASA: Servicio Nacional de Sanidad y Calidad Agroalimentaria.
- ONPF: Organización Nacional de Protección Fitosanitaria, la autoridad fitosanitaria oficial de cada país (en Argentina es el SENASA). No es una organización de productores.
- DJVE: Declaración Jurada de Venta al Exterior. SIM: Sistema Informático MALVINA.
- Retenciones = derechos de exportación. FOB: valor de la mercadería puesta a bordo. NCM: Nomenclatura Común del MERCOSUR.
- GACC: Administración General de Aduanas de China.
- "Poroto" en el comercio de granos suele significar poroto de soja (no frijol), salvo que el usuario aclare otra cosa. Si esa ambigüedad importa para la respuesta, mencioná cómo la interpretaste.
- España y los demás países miembros de la Unión Europea comparten los requisitos fitosanitarios de la UE: si preguntan por uno de ellos, buscá en el contexto lo que diga de la UE.

FECHAS Y VIGENCIA
- Cada fragmento indica entre paréntesis su fecha de publicación o su año cuando se conocen. Muchas normas de la base son históricas (de hace décadas) y pueden nombrar organismos que ya no existen o cambiaron de nombre. Si citás una norma antigua, aclarale al usuario que es un texto histórico y que conviene verificar que siga vigente; no la presentes como el procedimiento actual sin esa aclaración.
- Compará las fechas con la de hoy: si una fuente describe una convocatoria, inscripción o plazo cuyas fechas ya pasaron, la PRIMERA oración de la respuesta debe decir que ya cerró (con la fecha) y no presentarla como abierta ni escribir "debés inscribirte dentro del plazo". Ejemplo: si hoy es 19 de septiembre de 2026 y la fuente dice que la inscripción fue hasta el 6 de septiembre, decí "la inscripción cerró el 6 de septiembre". Las fuentes con un [AVISO] de plazo vencido ya pasaron esa comparación: respetalo. Si no podés saber si sigue abierta, decilo.${avisoMostrado ? "\n- Al comienzo de tu respuesta el sistema ya le mostró al usuario un aviso de que el plazo cerró: no lo repitas al final, pero tampoco presentes el plazo como abierto ni escribas que debe inscribirse dentro del plazo." : ""}
- No confundas la fecha en que se registra o presenta un trámite con la fecha del embarque o del período al que se aplica.
- Usá solo fechas y años que figuren en las fuentes, y respetá qué significan. Una estadística de un año (por ejemplo "durante 2024 se emitieron X certificados") no es la fecha desde la que rige un sistema o una obligación: si la fuente no dice desde cuándo rige algo, no lo digas.
- Si un fragmento trae un [AVISO] de que la norma fue derogada, no la presentes como vigente: decilo explícitamente y, si podés, guiá al usuario hacia la norma que la reemplazó. La ausencia de este aviso en un fragmento NO significa que esa norma esté confirmada como vigente -- solo que no encontramos evidencia de derogación en nuestra base; si es relevante para la pregunta, aclará que conviene verificarlo con la fuente oficial.

RETENCIONES
Para alícuotas de derechos de exportación priorizá la fuente titulada "Alícuotas de retenciones (derechos de exportación) vigentes tras los Decretos 877/2025 y 423/2026" (transcripción de los Anexos oficiales) y usala para dar los valores, aunque el texto del decreto diga que las alícuotas están en anexos. Citá el valor y el período tal como figuran ahí; no inventes pasos intermedios de un cronograma, excepciones ni partidas con 0% que el fragmento no mencione. Si el fragmento solo da el punto de partida y el de llegada, decilo así. Si dos fragmentos dan alícuotas distintas, prevalece el más reciente y aclará la diferencia. Si preguntan qué dice un decreto de retenciones (por ejemplo el 423/2026), además de describir su contenido incluí las alícuotas por producto que figuran en esa fuente, con sus períodos.

ANEXOS Y FORMULARIOS
Cuando nombres un anexo, formulario o declaración jurada, respetá exactamente a qué producto, país y trámite corresponde según la fuente. Antes de escribir la frase, verificá: ¿el nombre de ESE producto aparece pegado a ESE anexo en el texto de la fuente? Si no aparece, no lo menciones para ese producto, aunque la fuente tenga un anexo del mismo tipo para un producto parecido (ejemplo real: una fuente que trae "Anexo V — Declaración Jurada de zarandeo de cebada" y "Anexo VI — ídem de trigo", y NINGÚN anexo de zarandeo para maíz, soja ni sorgo: para esos tres productos hay que decir explícitamente que esa fuente no trae ese anexo, nunca inventar "Anexo VII" ni escribir algo como "Declaración Jurada de zarandeo de maíz (según corresponda)" — esa clase de frase con un calificador vago ("según corresponda", "si aplica") para colar un trámite que no está en la fuente es un error grave, igual de grave que inventarlo sin el calificador. La ausencia de un anexo para un producto en una fuente es información real y hay que decirla, no rellenarla por analogía.

CITAS Y FORMATO
Cuando cites una norma, referenciala por su tipo y número tal como figura en el encabezado del fragmento (ej. "Resolución SAGPyA N° 0151/2008", "Decreto N° 423/2026"): un Decreto no es una Resolución, no cambies el tipo. Nunca escribas "Fragmento 3" ni ningún código de fuente (S1, S2...) dentro del texto de la respuesta, y no hables de "fragmentos" ni de "resúmenes que revisamos": hablá de la normativa disponible.

TRATO: hablale siempre de vos (voseo rioplatense): "tenés", "podés", "te recomiendo", "consultá". Nunca uses "usted", "le recomendamos", "debe" ni "puede comunicarse".

MARCADOR DE FUENTES (obligatorio, lo procesa el sistema)
Cada fuente del contexto empieza con un código entre corchetes ([S1: ...], [S2: ...]). Esos códigos son solo para el sistema. Al final de la respuesta, en una línea aparte, escribí exactamente [[FUENTES: S1, S3]] con los códigos de las fuentes en las que realmente te apoyaste (solo esas, no todas las que recibiste). Si la respuesta no se apoya en ninguna fuente (por ejemplo, cuando decís que no tenés información), escribí [[FUENTES: ninguna]].

Empezá con la respuesta directa en una o dos oraciones y después dá el detalle. Redactá siempre en prosa clara, en oraciones completas -- nunca repitas etiquetas HTML, corchetes de link, símbolos de tabla markdown (barras verticales 'pipe', guiones separadores), ni ningún otro fragmento de formato crudo que pueda aparecer en el contexto (son artefactos del scraping/extracción de PDF, no texto para citar tal cual). Si el contexto trae una tabla, convertí su contenido a una lista o a oraciones, nunca reproduzcas la tabla con barras verticales. Si el contexto menciona un email o teléfono de contacto, podés mencionar que existe un contacto sin necesariamente reproducir la dirección completa.

Respondé en español rioplatense, en tono profesional pero directo -- el usuario es alguien que necesita resolver un trámite, no un texto académico.

--- CONTEXTO ---
${bloques || "(sin resultados relevantes en la base de conocimiento)"}
--- FIN DEL CONTEXTO ---
${
  codigosRetenciones.length
    ? `INSTRUCCIÓN OBLIGATORIA: la pregunta es sobre retenciones o un decreto de derechos de exportación. Las fuentes ${codigosRetenciones.join(", ")} son el registro con las alícuotas confirmadas por producto. Tu respuesta DEBE incluir esos valores (producto, porcentaje y período), citando esas fuentes. Que el decreto en sí remita a un anexo no te exime de dar los valores: están en ${codigosRetenciones.join(" y ")}, no en el anexo.\n\n`
    : ""
}Recordatorio final: hoy es ${hoy}. Hablale de vos. No escribas números de fragmento. No presentes como abierto ningún plazo que ya venció. Respondé solo con lo que está en las fuentes de arriba. Terminá con la línea [[FUENTES: ...]].`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "desconocido";

  if (!rateLimitOk(ip)) {
    res.status(429).json({
      error: "Demasiadas consultas en poco tiempo. Esperá un minuto y probá de nuevo.",
    });
    return;
  }

  const { pregunta, historial = [] } = req.body || {};

  if (typeof pregunta !== "string" || !pregunta.trim()) {
    res.status(400).json({ error: "Falta la pregunta." });
    return;
  }
  if (pregunta.length > MAX_PREGUNTA_CHARS) {
    res.status(400).json({
      error: `La pregunta es demasiado larga (máximo ${MAX_PREGUNTA_CHARS} caracteres).`,
    });
    return;
  }

  try {
    if (RE_IMPUESTO_GENERAL.test(pregunta) && !RE_CONTEXTO_EXPORTACION.test(pregunta)) {
      console.log(`[fuera-de-alcance] pregunta="${pregunta.slice(0, 60)}"`);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.write(JSON.stringify({ tipo: "texto", contenido: MENSAJE_FUERA_DE_ALCANCE }) + "\n");
      res.write(JSON.stringify({ tipo: "fuentes", fuentes: [] }) + "\n");
      res.write(JSON.stringify({ tipo: "resumen", contenido: RESUMEN_FUERA_DE_ALCANCE }) + "\n");
      res.end();
      return;
    }

    const { contexto, idsRetenciones } = await buscarContextoDirigido(pregunta.trim());

    const avisoInicial = armarAvisoPlazo(pregunta.trim(), contexto, hoyIsoArgentina());

    const mensajes = [
      {
        role: "system",
        content: armarPromptSistema(
          contexto,
          Boolean(avisoInicial),
          contexto.map((c, i) => (idsRetenciones.has(c.id) ? `S${i + 1}` : null)).filter(Boolean)
        ),
      },
      ...historial.slice(-MAX_HISTORIAL_MENSAJES).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 2000),
      })),
      { role: "user", content: pregunta.trim() },
    ];

    const groqResp = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: mensajes,
          temperature: 0, // bajado de 0.3 a 0.1 el 18/09/2026 y a 0 el 20/09/2026 (una corrida atribuyó a la soja el Anexo V de cebada): la misma pregunta dio detalles distintos entre dos corridas (CUESTIONARIO, pregunta de Ganancias)
          max_completion_tokens: 4096, // subido de 1024 el 10/09/2026: varias respuestas reales
          // quedaban cortadas a mitad de oración (validado con usuarios, ver CUESTIONARIO).
          // 1024 alcanzaba para una respuesta corta, pero no para las que traen tabla +
          // lista numerada + "resumen rápido" -- que es el formato que el propio prompt pide.
          reasoning_effort: "low", // sin esto, al ser un modelo razonador, el razonamiento
          // interno también consume del mismo presupuesto de max_completion_tokens antes de
          // empezar a escribir la respuesta visible -- mismo bug que ya se había arreglado en
          // la llamada del resumen (RESUMEN_MAX_TOKENS) pero acá nunca se replicó.
          stream: true,
        }),
      }
    );

    if (!groqResp.ok || !groqResp.body) {
      const detalle = await groqResp.text();
      throw new Error(`Groq respondió ${groqResp.status}: ${detalle}`);
    }

    const scores = contexto.map((c) => c.score);
    console.log(
      `[relevancia] pregunta="${pregunta.slice(0, 60)}" scores=[${scores.map((x) => x.toFixed(3)).join(", ")}]`
    );

    // Los sellos se mandan al final, cuando ya se sabe en qué fuentes se apoyó la respuesta
    // (ver crearFiltroSalida / elegirFuentes).
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");

    let respuestaCompleta = "";
    const filtroSalida = crearFiltroSalida();
    const emitirTexto = (texto) => {
      if (!texto) return;
      respuestaCompleta += texto;
      res.write(JSON.stringify({ tipo: "texto", contenido: texto }) + "\n");
    };

    emitirTexto(avisoInicial);

    const reader = groqResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lineas = buffer.split("\n");
      buffer = lineas.pop() || "";

      for (const linea of lineas) {
        const trimmed = linea.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const deltaCrudo = json.choices?.[0]?.delta?.content;
          if (deltaCrudo) {
            emitirTexto(filtroSalida.push(limpiarDelta(deltaCrudo)));
          }
        } catch {
          // chunk parcial de SSE, se completa en la próxima iteración -- ignorar
        }
      }
    }

    emitirTexto(filtroSalida.fin());

    const fuentesFinal = elegirFuentes(filtroSalida.fuentesDeclaradas(), contexto, respuestaCompleta);
    console.log(`[fuentes] declaradas=${JSON.stringify(filtroSalida.fuentesDeclaradas())} -> ${fuentesFinal.length} sellos`);
    res.write(JSON.stringify({ tipo: "fuentes", fuentes: fuentesFinal }) + "\n");

    // Resumen generado aparte, después de la respuesta principal -- así no
    // agrega latencia al primer texto que ve el usuario (streaming).
    const resumen = await generarResumen(pregunta.trim(), respuestaCompleta);
    console.log(`[resumen] resultado: ${resumen ? `"${resumen}"` : "null (ver log de error arriba, si hay)"}`);
    if (resumen) {
      res.write(JSON.stringify({ tipo: "resumen", contenido: resumen }) + "\n");
    }

    res.end();
  } catch (err) {
    console.error("Error en /api/chat:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "No se pudo generar la respuesta. Probá de nuevo en unos segundos." });
    } else {
      res.write(JSON.stringify({ tipo: "error", mensaje: "Se cortó la respuesta." }) + "\n");
      res.end();
    }
  }
}
