# Ceres AI — Agroexport RAG (granos y oleaginosas)

Asistente de consulta en lenguaje natural sobre requisitos fitosanitarios (SENASA) y aduaneros (ARCA) para exportar **soja, maíz, trigo y girasol** (y subproductos) desde Argentina. Cada respuesta cita la norma de la que sale la información.

**App en producción:** https://agroexport-rag-repo.vercel.app/ (acceso con clave compartida, ver "Variables de entorno")
**Última actualización de este README:** 27/09/2026

## Alcance

- **Productos:** soja, maíz, trigo, cebada, sorgo, girasol y subproductos (harinas, aceites, pellets).
- **Destinos con metadata estructurada:** China, Brasil. El resto de los destinos que aparecen en el corpus (UE, India, etc.) solo se recuperan por búsqueda semántica, no por filtro exacto.
- **Normativa:** requisitos fitosanitarios SENASA + normativa aduanera de exportación (ARCA, retenciones).
- **Fuera de alcance:** sanidad animal, productos frescos de consumo directo, impuestos generales (Ganancias, IVA, etc. — la app los rechaza explícitamente, ver "Prompt").

## Arquitectura

```
scraper/  ->  data/  ->  indexer/  ->  Pinecone  ->  api/chat.js  ->  src/ (React)
(fuentes)   (raw +      (chunking +   (índice        (retrieval +     (login, chat,
             processed)  embeddings)   agroexport-     Groq streaming)  historial,
                                       granos)                          favoritos)
                                                        api/login.js
                                                        (gate de acceso)
```

- **Frontend:** React + Vite (`src/App.jsx`, `src/index.css`). Gate de acceso con clave compartida (`LoginGate`), Historial y Favoritos (`localStorage`, locales a cada navegador), descarga de consultas como página HTML, ficha de norma en modal, sellos agrupados por organismo (SENASA/ARCA).
- **Backend:** dos funciones serverless de Vercel:
  - `api/chat.js`: retrieval + generación (streaming).
  - `api/login.js`: valida la clave de acceso contra `SITE_PASSWORD`.
  Las API keys y la clave de acceso viven solo en variables de entorno del servidor, nunca se envían al cliente.
- **Retrieval:** Pinecone con inferencia integrada (`llama-text-embed-v2`), índice `agroexport-granos`, namespace `default`, `TOP_K = 8`, más búsquedas dirigidas (ver "Prompt y retrieval").
- **Generación:** Groq, modelo `openai/gpt-oss-120b`, `temperature: 0`, respuesta en streaming (NDJSON: evento de fuentes, texto token a token, resumen).
- **Protecciones:** gate de acceso con clave compartida (frontend + backend, ver abajo); rate limit en memoria de 15 consultas/minuto por IP; pregunta máxima de 500 caracteres; el prompt obliga a responder solo con el contexto recuperado.

## Fuentes de datos

| Fuente | Cómo se obtiene | Notas |
| --- | --- | --- |
| Repositorio Institucional SENASA (biblioteca.senasa.gob.ar) | `scraper/senasa_repositorio.py` → `downloader.py` → `extract_text_local.py` → `extract_text_ocr.py` | Normativa histórica en PDF. Los PDFs escaneados se procesan con OCR (Tesseract). Filtrado por alcance en `chunking.py` (ver Bitácora, 21/09): 69 documentos únicos indexados de 234 encontrados. |
| Noticias y comunicados (argentina.gob.ar) | `scraper/argentina_noticias.py` (lista curada de URLs) | Protocolo y convocatoria de granos a China, ePhyto Brasil, y el registro manual de retenciones (mismo bucket, aunque temáticamente sea de ARCA). |
| ARCA / Aduana (argentina.gob.ar/normativa) | `scraper/arca_normativa.py` (lista curada `NORMAS_CANDIDATAS`) | RG 5872/2026, RG 5689/2025, RG 5687/2025, Ley 21.453, RG 128/2019, Decretos 877/2025 y 423/2026. |
| Alícuotas de retenciones | `scraper/agregar_retenciones_manual.py` | Transcripción manual de los Anexos del Decreto 423/2026 (InfoLEG / Boletín Oficial), porque los Anexos son imágenes. Se recupera por filtro exacto de URL (ver "Prompt y retrieval"), no solo por búsqueda semántica. |
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
python indexer/chunking.py                    # -> data/processed/chunks.json (con filtro de alcance)
python indexer/index_pinecone.py --limpiar-antes  # borra el namespace y sube todo de nuevo
python indexer/query_test.py --pregunta "..." # prueba de retrieval
```

`--limpiar-antes` en `index_pinecone.py` borra todos los vectores del namespace antes de subir los nuevos (el borrado no consume cuota de embeddings, solo el `upsert`). **Usarlo siempre** que `chunking.py` haya generado menos documentos que la corrida anterior (por ejemplo, después de ajustar el filtro de alcance): sin la flag, los chunks que salieron de `chunks.json` quedan como vectores huérfanos en Pinecone, todavía recuperables por la app aunque ya no tengan sentido. Después de un reindex completo, la inferencia integrada de Pinecone puede tardar más de los "10-20 segundos" habituales en reflejar todos los vectores nuevos.

Los PDFs (`data/raw/pdfs/`) y los textos extraídos (`data/processed/textos/`) no se versionan; viven en Drive.

## Prompt y retrieval (`api/chat.js`)

Reglas construidas en código, no solo pedidas en el texto del prompt (más confiables que depender de que el modelo las recuerde):

- **Plazos vencidos:** `detectarPlazosVencidos` busca frases tipo "hasta el 6 de septiembre" en cada fuente y las compara con la fecha de hoy; si venció, se agrega un `[AVISO]` a esa fuente y, si la pregunta menciona el país correspondiente, la respuesta arranca con un aviso fijo en vez de dejarlo para el final.
- **Anexos/declaraciones faltantes por producto:** `detectarZarandeoFaltante` detecta, dentro del propio texto de una fuente, para qué productos SÍ hay una "Declaración Jurada de zarandeo" mencionada explícitamente y para cuáles no, y fuerza un aviso. Se agregó después de que el modelo inventara ese trámite para maíz dos veces seguidas con distintas frases de cobertura ("según corresponda", "según el procedimiento de la convocatoria") a pesar de que el prompt ya lo prohibía en texto — corregirlo en código en vez de perseguir cada frase nueva.
- **Búsquedas dirigidas:** si la pregunta menciona retenciones/alícuotas/decretos 423 o 877, se suma una consulta con filtro exacto por la URL del registro de retenciones. Si menciona China o Brasil, se suma otra con filtro por `pais_destino`.
- **Instrucción forzada para retenciones:** si la búsqueda dirigida de retenciones trajo resultados, se agrega al final del prompt una instrucción obligatoria señalando exactamente qué fuentes (por código `S1`, `S2`...) tienen las alícuotas, porque una regla general no alcanzaba para que el modelo las usara en vez de remitir al Anexo III del decreto.
- **Puerta de alcance:** preguntas sobre impuestos generales (Ganancias, IVA, etc.) sin relación con exportación se responden con un mensaje fijo, sin llamar a Pinecone ni a Groq.
- **Sellos por cita real:** el modelo termina cada respuesta con `[[FUENTES: S1, S3]]` listando qué fuentes usó de verdad; el servidor arma los sellos solo con esas (no con todo lo que devolvió la búsqueda) y le pasa a cada sello un fragmento de texto citado (recortado a 500 caracteres) para la ficha de norma del frontend.
- **Gate de acceso:** cada request exige el header `x-site-password` con el mismo valor que `SITE_PASSWORD` (ver más abajo); si no coincide, devuelve 401 antes de tocar Pinecone o Groq.

## Variables de entorno (Vercel, Production)

| Variable | Contenido |
| --- | --- |
| `GROQ_API_KEY` | API key de Groq |
| `PINECONE_API_KEY` | API key de Pinecone (empieza con `pcsk_`) |
| `PINECONE_HOST` | **Host** del índice, del tipo `agroexport-granos-xxxx.svc.xxxx.pinecone.io`. No es la API key. `chat.js` le quita `https://` si lo trae. |
| `PINECONE_NAMESPACE` | Debe coincidir con el namespace usado al indexar (`default`) |
| `PINECONE_INDEX` | Nombre del índice (hoy `chat.js` no lo usa: la URL sale del host) |
| `SITE_PASSWORD` | Clave única compartida para entrar a la demo (no son cuentas por usuario). Si no está configurada, el gate se desactiva solo y deja pasar cualquier clave, para no dejar la app inaccesible por un olvido. Se valida en `api/login.js` y de nuevo en `api/chat.js` (header `x-site-password`), así no se puede saltear el login llamando directo a la API. |

Después de cambiar una variable hay que **redeployar**: Vercel no la aplica a deployments ya existentes.
El host se obtiene con:
`python -c "from pinecone import Pinecone; import os; print(Pinecone(api_key=os.environ['PINECONE_API_KEY']).describe_index('agroexport-granos').host)"`

## Estado actual (27/09/2026)

- App en producción, con gate de acceso por clave compartida activo, respondiendo con streaming, fuentes citadas y resumen de la consulta.
- Corpus: **1634 chunks** indexados (Repositorio 1514 + noticias 16 + ARCA 104), sin vectores huérfanos (reindex con `--limpiar-antes`).
- Versionado de normas: `vigente` es `false` solo con evidencia textual de derogación dentro del corpus; en cualquier otro caso es `null` ("no verificado"). Nunca se asume `true`.
- Retenciones: registro manual con las alícuotas de los Anexos del Decreto 423/2026 (trigo/cebada 5,5%; soja 24% en 2026 con baja gradual a 15% en 2028; maíz/sorgo 8,5% bajando a 5,5% en 2028; girasol 4,5% sin cronograma; biodiésel y aceite de soja con rangos propios). **Verificar contra el Boletín Oficial antes de citarlas como dato oficial**, y actualizar si sale otro decreto.
- Frontend: además del chat, tiene **Historial** (guardado automático de cada consulta, reabrir/eliminar/vaciar), **Favoritos** (normas puntuales marcadas a mano desde los sellos, no respuestas completas), **descarga de una consulta** como página HTML autocontenida (con botón de descarga real y de impresión/PDF), botón **"Nueva consulta"**, **sellos agrupados** por SENASA/ARCA cuando una respuesta tiene fuentes de los dos, y **ficha de norma** en modal (clic en un sello: organismo, tipo, estado, fragmento citado, link oficial). Todo lo de Historial/Favoritos es local al navegador (no hay cuentas de usuario ni backend de datos).
- Pruebas: batería de 5-14 preguntas corrida muchas veces entre el 12/09 y el 26/09 (`CUESTIONARIO.docx` + variantes), revisada a mano contra las fuentes reales del corpus en cada ronda. Encontró y permitió corregir errores reales del modelo (Anexo V atribuido a soja, fecha de una noticia mal leída, decreto sin alícuotas, Declaración Jurada de zarandeo inventada para maíz). Sigue siendo una prueba interna, **no** feedback de exportadores o despachantes: la validación con usuarios reales sigue pendiente.

## Bitácora

- **10/09/2026:** fixes post-deploy (pipes de markdown, responsive mobile con drawer, `TOP_K` 6→8, parsing de tablas HTML de ARCA, detección de cultivos en ARCA, versionado de normas). Se agregaron los Decretos 877/2025 y 423/2026 y el registro manual de retenciones.
- **13/09/2026:** fix en `index_pinecone.py`: los campos `vigente`, `derogada_por_*` y `evidencia_derogacion` se calculaban pero nunca llegaban a Pinecone.
- **15/09/2026:** OCR con Tesseract para los PDFs escaneados del Repositorio.
- **17/09/2026:** migración a una cuenta nueva de Pinecone.
- **18/09/2026:** error 500 en `/api/chat` (API key cargada por error en `PINECONE_HOST`). Corregido.
- **18-19/09/2026:** primera reescritura grande del prompt: nombre Ceres AI, glosario, regla de "solo contexto", puerta de alcance, plazos vencidos, voseo, sellos por cita, búsquedas dirigidas, `temperature` 0.3→0.1.
- **20-21/09/2026:** filtro exacto por URL para el registro de retenciones (reemplaza la búsqueda semántica por título, que traía los decretos en vez del registro); instrucción forzada en código para que las alícuotas se usen; regla de anexos y de fechas en el prompt (soluciona el caso del Anexo V atribuido a soja).
- **21/09/2026:** limpieza del corpus del Repositorio: filtro de alcance en `chunking.py` (234 → 69 documentos únicos, 3884 → 1514 chunks), recalculando cultivos sobre el texto post-OCR en vez de usar `cultivos_mencionados` (que quedaba vacío para los documentos escaneados). Reindex completo con la nueva flag `--limpiar-antes` de `index_pinecone.py`.
- **26/09/2026:** `temperature` a 0 y la Declaración Jurada de zarandeo de maíz seguía apareciendo inventada pese a dos correcciones de prompt distintas → se movió a detección en código (`detectarZarandeoFaltante`). Se agregó el fragmento de texto citado a cada sello (`recortarFragmento`). Frontend: Historial, Favoritos, descarga de consulta, "Nueva consulta", sellos agrupados por organismo, ficha de norma en modal; se sacaron "Consultas" y "Normativa"/"Descargas" del menú lateral (redundantes o reubicadas). Se corrigió un bug de HTML inválido (`<button>` anidado en otro `<button>`, el favorito dentro del sello).
- **27/09/2026:** gate de acceso con clave compartida (`SITE_PASSWORD`): `api/login.js` nuevo, chequeo duplicado en `api/chat.js` para que no se pueda saltear llamando directo a la API, pantalla de login en el frontend (`sessionStorage`, se pierde al cerrar la pestaña).

## Límites conocidos

- Casi todo el corpus tiene `vigente: null`: la app no puede afirmar que una norma esté vigente, solo detectar derogaciones explícitas.
- El texto de los PDFs escaneados viene de OCR y puede tener errores; los documentos del Repositorio son normativa histórica.
- El pipeline de actualización es **manual**: scraping, chunking y reindexado los corre una persona. No hay automatización que detecte cuándo una norma cambia.
- Los scores de similitud del corpus se mueven en un rango estrecho (~0.33–0.47), por lo que el ranking no separa bien lo relevante de lo parecido.
- El filtro de alcance del Repositorio (21/09) es heurístico: conserva un documento si menciona un cultivo en el texto, aunque no tenga relación real con exportación (caso conocido: una resolución de 1992 que aprueba un saborizante a base de "proteína vegetal hidrolizada de soja" para alimento animal sigue en el corpus, porque el texto dice "soja" literalmente).
- El scraper de ARCA/SENASA nunca buscó por "cebada" ni "sorgo" como palabra específica (solo por las 8 keywords de `senasa_repositorio.py`, que tampoco las incluye); dependen de aparecer dentro de una búsqueda genérica y mencionarse en el texto.
- Solo China y Brasil tienen `pais_destino` como metadata estructurada; para el resto de los países, el retrieval depende enteramente de la búsqueda semántica.
- El gate de acceso es una clave única compartida, no cuentas de usuario: no identifica quién pregunta, no hay registro de accesos, y cualquiera con la clave puede usarla desde cualquier dispositivo. Es suficiente para no dejar la demo abierta al público mientras se evalúa, no es un control de acceso serio para producción.
- Historial y Favoritos viven en `localStorage`/`sessionStorage` del navegador: no hay backend de datos, no se sincronizan entre dispositivos, y se pierden si el usuario borra los datos del sitio.
- Respuestas orientativas: verificar siempre con SENASA y ARCA antes de operar.

## Pendientes

- [x] Prompt del chat: Ceres AI, glosario, ARCA, alcance, plazos vencidos en código, sellos por citas, búsquedas dirigidas, temperature 0. (18-21/09)
- [x] Limpieza del corpus del Repositorio (filtro de alcance en `chunking.py`, 4004 → 1634 chunks). (21/09)
- [x] Detección en código de anexos/declaraciones faltantes por producto (no solo en el prompt). (26/09)
- [x] Historial, Favoritos, descarga de consulta, ficha de norma, sellos agrupados por organismo. (26/09)
- [x] Gate de acceso con clave compartida. (27/09)
- [ ] Validación con 2-3 exportadores o despachantes reales — sigue siendo el pendiente más importante, con la preselección del concurso corriendo del 1 al 28/10.
- [ ] Revisar si el filtro de alcance deja pasar documentos irrelevantes que solo mencionan un cultivo de casualidad (ver Límites conocidos); si aparecen casos en producción, evaluar una segunda pasada más fina.
- [ ] Ampliar las keywords de `senasa_repositorio.py` para incluir "cebada" y "sorgo" específicamente.
- [ ] Sumar más países con `pais_destino` estructurado (hoy solo China y Brasil).
- [ ] Verificar la fuente de la UE: la Directiva 2000/29/CE fue reemplazada por el Reglamento (UE) 2016/2031.
- [ ] Set de regresión formal: convertir el cuestionario en un archivo con pregunta + fuente esperada y correrlo tras cada cambio, en vez de revisar a mano cada vez.
- [ ] Reranking en la búsqueda de Pinecone.
- [ ] Marcar manualmente como superado el Decreto 877/2025 donde corresponda.
- [ ] Depurar el repo: borrar `scraper/chunking.py` (copia vieja), `scraper/arca_debug_*.html` y los `filtrar_chunks_*.py`.
- [ ] Acceso al Digesto Normativo SENASA.
- [ ] Automatizar el pipeline de noticias (GitHub Actions) y la detección de cambios normativos.
- [ ] Para el pitch del concurso: dejar por escrito un modelo de negocio (a quién se le cobra y cómo) y un roadmap explícito de automatización, ya que hoy el pipeline manual es una debilidad real frente a un jurado con inversores.
