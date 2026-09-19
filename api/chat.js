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

// Umbral de relevancia para filtrar chunks poco relacionados con la pregunta
// (ej. "requisitos para exportar soja a Japón", donde no hay nada relevante
// en la base y Pinecone igual devuelve sus 6 resultados "menos malos").
// SCORE_MINIMO_ABSOLUTO: si ni el mejor resultado supera esto, no se
//   considera que haya contexto relevante -- no se muestra ningún sello.
// SCORE_FACTOR_RELATIVO: dentro de los resultados que sí pasan el piso,
//   se descartan los que están muy por debajo del mejor resultado (ruido).
// Valores de partida sin calibrar con datos reales del proyecto -- revisar
// los console.log de scores en los primeros usos reales y ajustar si hace
// falta (ver README, sección de pendientes).
const SCORE_MINIMO_ABSOLUTO = 0.15;
const SCORE_FACTOR_RELATIVO = 0.55;

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

async function buscarContexto(pregunta) {
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

  const resp = await fetch(
    `https://${host}/records/namespaces/${PINECONE_NAMESPACE}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": apiKey,
        "X-Pinecone-Api-Version": "2025-10",
      },
      body: JSON.stringify({
        query: { inputs: { text: pregunta }, top_k: TOP_K },
      }),
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

function armarPromptSistema(contexto) {
  const bloques = contexto
    .map((c, i) => {
      const cita = c.numeroNorma
        ? `${[c.tipoNorma, c.organismoEmisor].filter(Boolean).join(" ")} N° ${c.numeroNorma}`
        : c.titulo;
      const avisoDerogacion =
        c.vigente === false
          ? `\n[AVISO: esta norma fue derogada por "${c.derogadaPorTitulo}". No la cites como vigente -- avisale al usuario que está derogada y, si el fragmento derogante también está en el contexto, preferí ese.]`
          : "";
      const fecha = c.fechaIso
        ? ` (publicado: ${c.fechaIso.slice(0, 10)})`
        : c.anio
          ? ` (año: ${c.anio})`
          : "";
      return `[Fragmento ${i + 1} — ${cita}${fecha}]${avisoDerogacion}\n${limpiarTexto(c.texto)}`;
    })
    .join("\n\n");

  const hoy = new Date().toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `Sos Ceres AI, un asistente que ayuda a exportadores argentinos de granos y oleaginosas (soja, maíz, trigo, girasol y sus subproductos) a entender los requisitos fitosanitarios y aduaneros para exportar. Hoy es ${hoy}.

REGLA PRINCIPAL: SOLO EL CONTEXTO
Respondé SOLO con lo que dicen los fragmentos de documentación oficial que se listan al final. No completes con conocimiento propio: no menciones organismos, sistemas informáticos, reglamentos de otros países, formularios, plazos, cifras ni requisitos que no estén escritos en los fragmentos, aunque los conozcas o te parezcan obvios. Nunca inventes números de resolución, fechas ni requisitos.

Si los fragmentos no alcanzan para responder:
- Si no hay nada relevante, empezá la respuesta con la frase "No tengo información en mi base sobre ..." y explicá en una o dos oraciones qué se consultó.
- Si la cobertura es parcial, contá solo lo que sí está respaldado por los fragmentos, sin usar esa frase, e indicá con claridad qué parte no está cubierta.
- En ambos casos, orientá al usuario a consultar directamente al SENASA (temas fitosanitarios) o a ARCA (temas aduaneros e impositivos), sin inventar contactos, links ni pasos que no figuren en el contexto.

ALCANCE
Tu base cubre requisitos fitosanitarios (SENASA), trámites aduaneros y de registro de exportación (ARCA) y derechos de exportación (retenciones) de granos y oleaginosas. Si la pregunta es de otro tema (impuestos generales, otros productos, países que no figuran en el contexto), decilo. No reinterpretes la pregunta para que encaje con lo que sí tenés: si el usuario pregunta por X y la base solo tiene algo parecido pero distinto, aclará que no es lo mismo que preguntó y ofrecé lo que sí hay.

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
- Compará las fechas con la de hoy: si un fragmento describe una convocatoria, inscripción o plazo cuyas fechas ya pasaron, decí que ya cerró (con la fecha) y no la presentes como abierta. Si no podés saber si sigue abierta, decilo.
- No confundas la fecha en que se registra o presenta un trámite con la fecha del embarque o del período al que se aplica.
- Si un fragmento trae un [AVISO] de que la norma fue derogada, no la presentes como vigente: decilo explícitamente y, si podés, guiá al usuario hacia la norma que la reemplazó. La ausencia de este aviso en un fragmento NO significa que esa norma esté confirmada como vigente -- solo que no encontramos evidencia de derogación en nuestra base; si es relevante para la pregunta, aclará que conviene verificarlo con la fuente oficial.

RETENCIONES
Para alícuotas de derechos de exportación priorizá el fragmento cuyo título empieza con "Resumen verificado" y usalo para dar los valores, aunque el texto del decreto diga que las alícuotas están en anexos. Citá el valor y el período tal como figuran ahí; no inventes pasos intermedios de un cronograma, excepciones ni partidas con 0% que el fragmento no mencione. Si el fragmento solo da el punto de partida y el de llegada, decilo así. Si dos fragmentos dan alícuotas distintas, prevalece el más reciente y aclará la diferencia.

CITAS Y FORMATO
Cuando cites una norma, referenciala por su tipo y número tal como figura en el encabezado del fragmento (ej. "Resolución SAGPyA N° 0151/2008", "Decreto N° 423/2026"): un Decreto no es una Resolución, no cambies el tipo. No la cites por el número de fragmento, y no hables de "fragmentos" ni de "resúmenes que revisamos"; hablá de la normativa disponible.

Empezá con la respuesta directa en una o dos oraciones y después dá el detalle. Redactá siempre en prosa clara, en oraciones completas -- nunca repitas etiquetas HTML, corchetes de link, símbolos de tabla markdown (barras verticales 'pipe', guiones separadores), ni ningún otro fragmento de formato crudo que pueda aparecer en el contexto (son artefactos del scraping/extracción de PDF, no texto para citar tal cual). Si el contexto trae una tabla, convertí su contenido a una lista o a oraciones, nunca reproduzcas la tabla con barras verticales. Si el contexto menciona un email o teléfono de contacto, podés mencionar que existe un contacto sin necesariamente reproducir la dirección completa.

Respondé en español rioplatense, en tono profesional pero directo -- el usuario es alguien que necesita resolver un trámite, no un texto académico.

--- CONTEXTO ---
${bloques || "(sin resultados relevantes en la base de conocimiento)"}`;
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
    const contexto = await buscarContexto(pregunta.trim());

    const mensajes = [
      { role: "system", content: armarPromptSistema(contexto) },
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
          temperature: 0.1, // bajado de 0.3 el 18/09/2026: la misma pregunta dio detalles distintos entre dos corridas (CUESTIONARIO, pregunta de Ganancias)
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

    // Filtro de relevancia: si nada de lo recuperado es realmente relevante
    // para la pregunta (ej. un país/producto que no está en la base), no
    // mostramos sellos de normas que no tienen que ver -- confunden más de
    // lo que ayudan.
    const scores = contexto.map((c) => c.score);
    const mejorScore = scores.length ? Math.max(...scores) : 0;
    console.log(
      `[relevancia] pregunta="${pregunta.slice(0, 60)}" mejorScore=${mejorScore.toFixed(4)} scores=[${scores.map((s) => s.toFixed(3)).join(", ")}]`
    );
    const contextoRelevante =
      mejorScore >= SCORE_MINIMO_ABSOLUTO
        ? contexto.filter((c) => c.score >= mejorScore * SCORE_FACTOR_RELATIVO)
        : [];

    // Varios de los chunks recuperados pueden venir del mismo documento
    // (mismo id, distinto chunk_index) -- deduplicamos por id para que el
    // "sello" no muestre la misma norma repetida.
    const fuentesUnicas = [];
    const idsVistos = new Set();
    for (const c of contextoRelevante) {
      if (idsVistos.has(c.documentoId)) continue;
      idsVistos.add(c.documentoId);
      fuentesUnicas.push({
        titulo: c.titulo,
        tipoNorma: c.tipoNorma,
        organismoEmisor: c.organismoEmisor,
        numeroNorma: c.numeroNorma,
        anio: c.anio,
        fuente: c.fuente,
        url: c.url,
        vigente: c.vigente,
        derogadaPorTitulo: c.derogadaPorTitulo,
      });
    }

    // Antes del streaming del texto, mandamos un primer evento con las
    // fuentes citables -- el frontend arma el "sello" con esto sin tener
    // que parsear el texto de la respuesta.
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.write(JSON.stringify({ tipo: "fuentes", fuentes: fuentesUnicas }) + "\n");

    const reader = groqResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let respuestaCompleta = "";

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
            const delta = limpiarDelta(deltaCrudo);
            respuestaCompleta += delta;
            res.write(JSON.stringify({ tipo: "texto", contenido: delta }) + "\n");
          }
        } catch {
          // chunk parcial de SSE, se completa en la próxima iteración -- ignorar
        }
      }
    }

    // El filtro por score (arriba) no distingue bien "relevante" de
    // "parecido pero no relacionado" -- se probó con datos reales y el
    // score de una pregunta sin cobertura (0.38) quedó muy cerca del de una
    // pregunta bien cubierta (0.50), sin un salto claro para poner un
    // umbral confiable. En cambio, el modelo SÍ distingue bien cuándo no
    // tiene información (lo dice explícitamente) -- así que la señal más
    // confiable es leer su propia respuesta: si dice que no tiene datos,
    // ocultamos los sellos que se habían mandado al principio, sin importar
    // qué haya encontrado Pinecone.
    const SIN_INFO_PATRON = /no dispongo de informaci[oó]n|no tengo informaci[oó]n|no cuento con informaci[oó]n|no se incluye informaci[oó]n|no se encuentra informaci[oó]n|no hay informaci[oó]n|no consta\b|no se especifica|no se detalla/i;
    if (fuentesUnicas.length > 0 && SIN_INFO_PATRON.test(respuestaCompleta)) {
      res.write(JSON.stringify({ tipo: "fuentes", fuentes: [] }) + "\n");
    }

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
