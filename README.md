# Ceres AI — Agroexport RAG (granos y oleaginosas)

Asistente de consulta en lenguaje natural sobre requisitos fitosanitarios (SENASA) y aduaneros (ARCA) para exportar **soja, maíz, trigo y girasol** (y subproductos) desde Argentina. Cada respuesta cita la norma de la que sale la información.

**App en producción:** https://agroexport-rag-repo.vercel.app/
**Última actualización de este README:** 18/09/2026

## Alcance

- **Productos:** soja, maíz, trigo, girasol y subproductos (harinas, aceites, pellets).
- **Destinos prioritarios:** China, Unión Europea, Brasil, India.
- **Normativa:** requisitos fitosanitarios SENASA + normativa aduanera de exportación (ARCA, retenciones).
- **Fuera de alcance:** sanidad animal, productos frescos de consumo directo.

## Arquitectura

```
scraper/  ->  data/  ->  indexer/  ->  Pinecone  ->  api/chat.js  ->  src/ (React)
(fuentes)   (raw +      (chunking +   (índice        (retrieval +     (chat, sellos
             processed)  embeddings)   agroexport-     Groq streaming)  de normas)
                                       granos)
```

- **Frontend:** React + Vite (`src/App.jsx`, `src/index.css`).
- **Backend:** función serverless de Vercel (`api/chat.js`). Las API keys viven solo en variables de entorno del servidor.
- **Retrieval:** Pinecone con inferencia integrada (`llama-text-embed-v2`), índice `agroexport-granos`, namespace `default`, `TOP_K = 8`.
- **Generación:** Groq, modelo `openai/gpt-oss-120b`, respuesta en streaming (NDJSON: evento de fuentes, texto token a token, resumen).
- **Protecciones:** rate limit en memoria de 15 consultas/minuto por IP; pregunta máxima de 500 caracteres; el prompt obliga a responder solo con el contexto recuperado.

## Fuentes de datos

| Fuente | Cómo se obtiene | Notas |
| --- | --- | --- |
| Repositorio Institucional SENASA (biblioteca.senasa.gob.ar) | `scraper/senasa_repositorio.py` → `downloader.py` → `extract_text_local.py` → `extract_text_ocr.py` | Normativa histórica en PDF. Los PDFs escaneados se procesan con OCR (Tesseract). |
| Noticias y comunicados (argentina.gob.ar) | `scraper/argentina_noticias.py` (lista curada de URLs) | Protocolo y convocatoria de granos a China, ePhyto Brasil, documentos genéricos. |
| ARCA / Aduana (argentina.gob.ar/normativa) | `scraper/arca_normativa.py` (lista curada `NORMAS_CANDIDATAS`) | RG 5872/2026, RG 5689/2025, RG 5687/2025, Ley 21.453, RG 128/2019, Decretos 877/2025 y 423/2026. |
| Alícuotas de retenciones | `scraper/agregar_retenciones_manual.py` | Transcripción manual de los Anexos del Decreto 423/2026 (InfoLEG / Boletín Oficial), porque los Anexos son imágenes. |
| Digesto Normativo SENASA | — | Bloqueado por robots.txt. Pendiente pedir acceso a biblioteca@senasa.gob.ar. |

## Cómo correr el pipeline

```
pip install -r requirements.txt

python scraper/senasa_repositorio.py          # índice del Repositorio
python scraper/downloader.py                  # descarga PDFs + detecta cultivos
python scraper/extract_text_local.py          # texto de PDFs con capa de texto
python scraper/extract_text_ocr.py            # OCR para PDFs escaneados (requiere Tesseract)
python scraper/argentina_noticias.py          # noticias
python scraper/arca_normativa.py              # normativa ARCA
python scraper/agregar_retenciones_manual.py  # registro manual de retenciones
python indexer/chunking.py                    # -> data/processed/chunks.json
python indexer/index_pinecone.py              # sube a Pinecone (usa PINECONE_API_KEY)
python indexer/query_test.py --pregunta "..." # prueba de retrieval
```

Los PDFs (`data/raw/pdfs/`) y los textos extraídos (`data/processed/textos/`) no se versionan; viven en Drive.

## Variables de entorno (Vercel, Production)

| Variable | Contenido |
| --- | --- |
| `GROQ_API_KEY` | API key de Groq |
| `PINECONE_API_KEY` | API key de Pinecone (empieza con `pcsk_`) |
| `PINECONE_HOST` | **Host** del índice, del tipo `agroexport-granos-xxxx.svc.xxxx.pinecone.io`. No es la API key. `chat.js` le quita `https://` si lo trae. |
| `PINECONE_NAMESPACE` | Debe coincidir con el namespace usado al indexar (`default`) |
| `PINECONE_INDEX` | Nombre del índice (hoy `chat.js` no lo usa: la URL sale del host) |

Después de cambiar una variable hay que **redeployar**: Vercel no la aplica a deployments ya existentes.
El host se obtiene con:
`python -c "from pinecone import Pinecone; import os; print(Pinecone(api_key=os.environ['PINECONE_API_KEY']).describe_index('agroexport-granos').host)"`

## Estado actual (18/09/2026)

- App en producción, respondiendo con streaming, fuentes citadas y resumen de la consulta.
- Última corrida local de `chunking.py`: **4004 chunks** (Repositorio SENASA + noticias + ARCA). Pinecone en cuenta nueva desde el 17/09.
- Versionado de normas: `vigente` es `false` solo con evidencia textual de derogación dentro del corpus; en cualquier otro caso es `null` ("no verificado"). Nunca se asume `true`.
- Retenciones: registro manual con las alícuotas de los Anexos del Decreto 423/2026 (trigo/cebada 5,5%; soja 24% en 2026 con baja gradual; maíz/sorgo 8,5%; girasol 4,5%). **Verificar contra el Boletín Oficial antes de citarlas como dato oficial**, y actualizar si sale otro decreto.
- Validación con usuarios: realizada con cuestionario. *(Completar acá los resultados y los cambios que salieron del feedback.)*

## Bitácora

- **10/09/2026:** fixes post-deploy (pipes de markdown, responsive mobile con drawer, `TOP_K` 6→8, parsing de tablas HTML de ARCA, detección de cultivos en ARCA, versionado de normas). Se agregaron los Decretos 877/2025 y 423/2026 y el registro manual de retenciones. Ese mismo día el registro pasó de fuentes periodísticas a transcripción de los Anexos oficiales; se corrigió girasol (4,5% general, sin cronograma de baja).
- **13/09/2026:** fix en `index_pinecone.py`: los campos `vigente`, `derogada_por_*` y `evidencia_derogacion` se calculaban pero nunca llegaban a Pinecone. Se documentó la cuota gratuita de embeddings (5M tokens/mes): conviene validar todo localmente y reindexar una sola vez por sesión.
- **15/09/2026:** OCR con Tesseract para los PDFs escaneados del Repositorio. `index_pinecone.py` ahora saltea chunks vacíos y divide los lotes que fallan para aislar el registro problemático.
- **17/09/2026:** migración a una cuenta nueva de Pinecone. `chat.js` normaliza `PINECONE_HOST` (quita `https://` y barras finales).
- **18/09/2026:** error 500 en `/api/chat` (`getaddrinfo ENOTFOUND pcsk_...`): la API key quedó cargada en `PINECONE_HOST`. Se corrigieron `PINECONE_HOST` y `PINECONE_API_KEY` en Vercel y se redeployó.

## Límites conocidos

- Casi todo el corpus tiene `vigente: null`: la app no puede afirmar que una norma esté vigente, solo detectar derogaciones explícitas.
- El texto de los PDFs escaneados viene de OCR y puede tener errores; los documentos del Repositorio son normativa histórica.
- El pipeline de actualización es **manual**. Las convocatorias y los plazos (por ejemplo, la inscripción de exportadores a China, 24/08–06/09/2026) pueden estar vencidos.
- Los scores de similitud del corpus se mueven en un rango estrecho (~0.33–0.47), por lo que el ranking no separa bien lo relevante de lo parecido.
- Las respuestas son orientativas. Verificar siempre con SENASA y ARCA antes de operar.

## Pendientes

- [ ] Prompt del chat: reemplazar "Zarpe" por "Ceres AI".
- [ ] Pasar fecha de hoy y fecha de cada fragmento al prompt; mostrar la fecha en los sellos.
- [ ] Filtrar el corpus del Repositorio por relevancia (recalcular `cultivos_mencionados` sobre el texto de OCR) y marcar los chunks de OCR.
- [ ] Reranking en la búsqueda de Pinecone y filtro por metadata (cultivo y país).
- [ ] Marcar manualmente como superado el Decreto 877/2025 donde corresponda.
- [ ] Depurar el repo: borrar `scraper/chunking.py` (copia vieja), `scraper/arca_debug_*.html` y los `filtrar_chunks_*.py`.
- [ ] Documentar los resultados del cuestionario de validación.
- [ ] Acceso al Digesto Normativo SENASA.
- [ ] Automatizar el pipeline de noticias (GitHub Actions) y la detección de cambios.
