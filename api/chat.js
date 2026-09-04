// api/chat.js
// Función serverless (Vercel): pipeline RAG completo para Zarpe.
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
const TOP_K = 6;
const MAX_PREGUNTA_CHARS = 500;
const MAX_HISTORIAL_MENSAJES = 8; // últimos N mensajes del historial, para no inflar el prompt

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
  const host = process.env.PINECONE_HOST; // ver README: cómo obtener el host del índice

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
    paisDestino: hit.fields?.pais_destino || null,
    cultivos: hit.fields?.cultivos || [],
    url: hit.fields?.url || null,
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

function armarPromptSistema(contexto) {
  const bloques = contexto
    .map((c, i) => {
      const cita = c.numeroNorma
        ? `${c.tipoNorma} ${c.organismoEmisor} N° ${c.numeroNorma}`
        : c.titulo;
      return `[Fragmento ${i + 1} — ${cita}]\n${limpiarTexto(c.texto)}`;
    })
    .join("\n\n");

  return `Sos Zarpe, un asistente que ayuda a exportadores argentinos de granos y oleaginosas (soja, maíz, trigo, girasol) a entender los requisitos fitosanitarios y aduaneros para exportar.

Respondé SOLO en base a los fragmentos de documentación oficial que se listan abajo. Si la pregunta no puede responderse con esos fragmentos, decilo explícitamente en vez de inventar una respuesta -- nunca inventes números de resolución, fechas, ni requisitos que no estén en el contexto.

Cuando cites una norma, referenciala por su tipo y número (ej. "Resolución SAGPyA N° 0151/2008"), no por el número de fragmento.

Redactá siempre en prosa clara, en oraciones completas -- nunca repitas etiquetas HTML, corchetes de link, símbolos de tabla markdown (barras verticales 'pipe', guiones separadores), ni ningún otro fragmento de formato crudo que pueda aparecer en el contexto (son artefactos del scraping/extracción de PDF, no texto para citar tal cual). Si el contexto trae una tabla, convertí su contenido a una lista o a oraciones, nunca reproduzcas la tabla con barras verticales. Si el contexto menciona un email o teléfono de contacto, podés mencionar que existe un contacto sin necesariamente reproducir la dirección completa.

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
          temperature: 0.3,
          max_completion_tokens: 1024,
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
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
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
