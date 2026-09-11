# Agroexport RAG — Granos y Oleaginosas  (PRODUCCIÓN)

RAG de normativa SENASA/aduanera para exportadores de granos y oleaginosas
(soja, maíz, trigo, girasol). 

## Alcance definido

- **Productos**: soja, maíz, trigo, girasol y subproductos (harinas, aceites, pellets)
- **Destinos prioritarios**: China, Unión Europea, Brasil, India
- **Tipo de normativa**: requisitos fitosanitarios SENASA + normativa aduanera
  de exportación. Fuera de alcance: sanidad animal, productos frescos de
  consumo directo.

## Fuentes de datos

| Fuente | Acceso | Estado |
|---|---|---|
| Digesto Normativo SENASA (digesto.senasa.gob.ar) | Bloquea scraping automático (robots.txt) | Requiere descarga manual/asistida o pedir acceso alternativo vía biblioteca@senasa.gob.ar. Confirmado que tiene estructura por capítulo (ej. "Cereales oleaginosos... Sección 7° - Exportación de granos") |
| Repositorio Institucional SENASA (biblioteca.senasa.gob.ar) | Omeka, público, 5761 ítems | ✅ Scraping funcional y validado (search= + output=rss2). 234 docs indexados por keyword, 74 con mención explícita de cultivo tras filtrar por texto |
| **argentina.gob.ar/noticias** | HTML plano, scrapeable | 🎯 Prioritaria: comunicados de protocolos bilaterales por país/producto, actualizados. Confirmado caso vigente: convocatoria de exportadores de granos a China (24/08 - 06/09/2026). Ampliada con 2 noticias más (ver abajo) |
| **argentina.gob.ar/senasa/.../protocolos-de-exportacion** (Portal de Certificación Fitosanitaria de Exportación) | HTML plano (páginas de sección "book", no "noticia"), scrapeable con un parser distinto al de noticias | 🆕 Fuente nueva, más estable que las noticias sueltas: índice fijo con una página por país (Brasil, China, Corea, EEUU, México, Perú, Unión Europea, Vietnam, etc.) con los acuerdos bilaterales vigentes. **Ojo**: la página de "Unión Europea" hoy solo tiene el instructivo de fruta cítrica, no cubre granos -- para UE el requisito de granos es la normativa general (Directiva de Sanidad Vegetal 2000/29/EC), no un protocolo bilateral negociado como el de China |
| **argentina.gob.ar/senasa/.../documentacion-oficial-de-las-onpf** | HTML plano, tabla + links | 🆕 Fuente nueva: listado completo de requisitos por país de destino (permisos de importación vs. normativa general). Confirma India (PDF único: Plant Quarantine Order 2003) y UE (Directiva 2000/29/EC) explícitamente. También trae una tabla de países con intervención obligatoria de SENASA para subproductos de granos (harinas, pellets, expellers, tortas) |
| Consulta de disposiciones de ingreso (aps3.senasa.gov.ar) | Aplicación JSF con estado de sesión | Difícil de scrapear (no hay parámetros GET simples), baja prioridad |
| vgs.senasa.gov.ar | — | Descartado: es el buscador de requisitos **zoosanitarios** (animal), no aplica a granos/vegetal |
| Aduana/ARCA (argentina.gob.ar/normativa) | HTML plano por norma (`/normativa/nacional/<slug>/texto`), scrapeable | ✅ `scraper/arca_normativa.py` funcional y validado: 7 normas indexadas (RG 5872/2026, RG 5689/2025, RG 5687/2025, Ley 21.453, RG 128/2019 MAGyP-DJVE, Decreto 877/2025, Decreto 423/2026). **Limitación conocida**: los decretos de derechos de exportación (retenciones) remiten sus alícuotas a Anexos adjuntos vía sistema GDE (`IF-2026-...-APN-SSMAEII#MEC`) sin URL pública descargable -- el texto scrapeado del decreto en sí NUNCA tiene el número concreto. Se resolvió con un registro manual curado (`scraper/agregar_retenciones_manual.py`) que cruza 3 fuentes periodísticas (La Nación, Infobae, Infocampo) y cita el Boletín Oficial para verificación -- ver sección "Sesión 10/09/2026" más abajo |

## Estructura de carpetas

```
agroexport-rag/
├── scraper/          # descarga de normativa desde las fuentes
├── data/
│   ├── raw/           # PDFs e índices de metadata sin procesar
│   └── processed/     # texto limpio + chunks con metadata
├── indexer/           # chunking, embeddings, carga a vector store
├── api/                # backend de retrieval + generación
├── frontend/           # UI de chat (reusar base de Norma-AR)
└── docs/                # este README y notas de decisiones
```

## Pasos, en orden

1. **Validar fuentes de datos** (antes de escalar el scraping)
   - Confirmar en el navegador qué parámetro filtra realmente en
     biblioteca.senasa.gob.ar (search / query / search_field).
   - Evaluar si el Digesto Normativo requiere contacto directo con SENASA
     para acceso a datos abiertos, dado el bloqueo de robots.txt.
   - Probar el buscador de requisitos sanitarios (vgs.senasa.gov.ar) para 2-3
     combinaciones producto/país y confirmar estructura de respuesta.

2. **Scraping / adquisición**
   - `scraper/senasa_repositorio.py`: trae índice de metadata + URLs de PDF
     del Repositorio (ejecutar primero con una keyword para validar, después
     escalar).
   - Downloader de PDFs a partir de ese índice (siguiente script a armar).
   - Scraper puntual del buscador de requisitos sanitarios.

3. **Procesamiento**
   - Extracción de texto de PDFs.
   - Chunking con metadata: producto, país de destino, tipo de norma
     (resolución / alerta sanitaria / requisito específico), fecha, vigente/no vigente.

4. **Indexado**
   - Embeddings + vector store: **Pinecone con inferencia integrada** (mismo
     stack que Norma-AR), modelo `llama-text-embed-v2` (NVIDIA, vía Pinecone
     Inference -- no directo por Groq, se corrigió un dato erróneo de la doc
     de referencia que mezclaba specs de otro modelo, NV-Embed-v2). Plan
     Starter (gratis) alcanza sobrado: 1841 chunks ≈ 460k tokens, contra
     100k vectores y 5M tokens/mes gratis.
   - Retrieval en dos pasos: filtro por metadata (producto + país) primero,
     luego semántico dentro de ese subconjunto.

5. **Pipeline de actualización incremental**
   - Job periódico que detecte altas/bajas en el Repositorio y en el Digesto.
   - Versionado: marcar normas reemplazadas como no vigentes en vez de borrarlas.

6. **API + Frontend**
   - Backend de retrieval + generación, citando número de resolución en cada respuesta.
   - UI tipo chat (reusar base de Norma-AR).
   - Caso de demo: "Soy exportador de soja a China, ¿qué certificados necesito?"

7. **Validación con usuarios reales**
   - Feedback de 2-3 exportadores o despachantes de aduana antes de la
     preselección técnica (1-28 de octubre 2026).

## Estado actual

- [x] Estructura de carpetas creada
- [x] Scraper del Repositorio Institucional validado (search= + output=rss2)
- [x] Índice de 234 documentos bajado; 74 con mención explícita de cultivo tras filtrar por texto (`downloader.py`)
- [x] PDFs relevantes descargados y verificados (74, texto extraíble al 100%, muestra de relevancia confirmada)
- [x] Identificada y descartada fuente equivocada (vgs.senasa.gov.ar = zoosanitario, no aplica)
- [x] Identificada fuente prioritaria para el caso de demo: argentina.gob.ar/noticias (protocolos bilaterales por país/producto, contenido vigente)
- [x] Scraper de argentina.gob.ar/noticias armado (`argentina_noticias.py`) -- requiere lista curada de URLs, no hay endpoint de búsqueda público
- [x] Ampliar lista de URLs de argentina.gob.ar/noticias (Brasil, UE, India). Resultado:
  - [x] Brasil: sumada 1 noticia relevante (incorporación al sistema ePhyto, menciona trigo/cebada)
  - [x] China: sumada 1 noticia adicional (noticia fundacional del protocolo de granos)
  - [x] UE e India: confirmado que **no existen** noticias puntuales para granos con este formato. Documentadas como fuente de referencia aparte (`URLS_REFERENCIA_NO_NOTICIA` en el script): Portal de Certificación Fitosanitaria de Exportación (páginas por país) + Documentación oficial de las ONPF (India: PDF único Plant Quarantine Order 2003; UE: Directiva 2000/29/EC, sin protocolo bilateral de granos como el de China)
  - [x] Scraper corrido y validado end-to-end sobre las 3 URLs (`data/raw/argentina_noticias_index.json`). En la validación con datos reales se encontraron y corrigieron 3 bugs del parser:
    1. `Path(__file__)` fallaba al pegar el código en una celda de Colab/Jupyter (no existe `__file__` fuera de un archivo .py) -- resuelto con fallback a `Path.cwd()`
    2. `soup.find("h1")` devolvía siempre "Presidencia de la Nación" (el h1 de branding institucional del sitio, no el título de la noticia) -- resuelto usando el meta `og:title`
    3. La fecha vía regex sobre el cuerpo daba `None` cuando el texto visible menciona el día sin año pegado (ej. "desde el 24 de agosto y hasta el 6 de septiembre") -- resuelto usando el meta `article:published_time` (ISO) como fuente primaria; se agregó también el campo `fecha_iso` para poder ordenar/filtrar vigente vs. no vigente en el paso de indexado
  - [ ] Pendiente (opcional, no bloqueante): un segundo scraper para las páginas tipo "book" del Portal de Certificación (Brasil, UE, India, Cosave, Corea, Japón, México, Perú, Vietnam) si se quiere cobertura completa de esos países más allá de las noticias puntuales
- [ ] Resolución de acceso al Digesto Normativo (bloqueado por robots.txt)
- [ ] Evaluar si vale la pena el esfuerzo de scrapear aps3.senasa.gov.ar (app JSF, complejo)
- [x] Procesamiento / chunking unificado (Repositorio + noticias). Resultado final:
  - [x] **Hallazgo importante**: `downloader.py` extrae el texto de cada PDF para detectar cultivos, pero solo guardaba el LARGO (`texto_extraido_chars`), nunca el texto en sí -- no había forma de hacer chunking real del Repositorio con lo que teníamos. Se sumó `scraper/extract_text_local.py`, que relee los PDFs ya descargados (los que están en Drive) y persiste el texto completo en `data/processed/textos/*.txt`, sin volver a descargar nada
  - [x] `indexer/chunking.py`: junta Repositorio + noticias en un esquema común (`fuente`, `documento_id`, `titulo`, `tipo_norma`, `organismo_emisor`, `numero_norma`, `anio`, `fecha`/`fecha_iso`, `pais_destino`, `cultivos`, `chunk_index`, `texto`). Chunking simple por párrafo, ~1000 caracteres por chunk
  - [x] Metadata del Repositorio se parsea del patrón del título ("Resolución/Disposición \<Organismo\> N° \<num\>/\<año\>") sin abrir el PDF -- validado contra los 234 títulos reales: 228/234 matchean (los 6 restantes son guías/manuales/fichas técnicas, correctamente sin número de norma)
  - [x] **Corrida completa y validada con datos reales de las dos fuentes**: `extract_text_local.py` sobre los 74 PDFs de Drive (74/74 encontrados, texto extraído legible -- revisado a mano, sin basura de OCR ni palabras pegadas) → `chunking.py` → **1841 chunks totales** (1832 del Repositorio de 74 documentos únicos + 9 de las 3 noticias). A nivel documento (no chunk), 71/74 documentos del Repositorio tienen `tipo_norma` detectado (los 3 restantes son guías/fichas técnicas sin número de resolución, como se esperaba). Metadata cruzada contra el texto real: organismo/número/año coinciden con el contenido de la norma. País y cultivos de las 3 noticias correctos en los 9 chunks
  - [ ] `pais_destino` y `cultivos` de las noticias están hardcodeados a mano en `chunking.py` (son solo 3-5 hoy) -- si la lista de noticias crece, conviene automatizarlo. (Para ARCA, en cambio, esto **sí** se automatizó el 10/09/2026: `_detectar_cultivos()` en `chunking.py` etiqueta cultivos por palabra clave en título+cuerpo)
  - [x] `vigente` -- implementado 10/09/2026 (`detectar_derogaciones()` en `chunking.py`), ver detalle en "Sesión 10/09/2026" más abajo. Diseño a propósito conservador: solo marca `vigente: false` con evidencia textual explícita de derogación encontrada dentro del propio corpus ("Derógase la Resolución N° X/AAAA"); todo lo demás queda `vigente: null` ("no verificado"), nunca se asume `true`
- [x] Indexado
  - [x] Stack: Pinecone (inferencia integrada, `llama-text-embed-v2`) para embeddings + vector store, mismo modelo que usa Norma-AR. Entra cómodo en el plan gratuito (Starter: 100k vectores / 5M tokens por mes; usamos 1841 chunks ≈ 460k tokens)
  - [x] `indexer/index_pinecone.py`: sube los chunks de `chunks_completo.json` a Pinecone con `upsert_records` (batches de 90). Incluye reintentos con backoff exponencial para el rate limit del plan gratis (250k tokens/minuto) -- se pisó una vez en la corrida real y se resolvió solo
  - [x] `indexer/query_test.py`: prueba de retrieval semántico
  - [x] **Corrida real y validada**: los 1841 chunks quedaron indexados en Pinecone (índice `agroexport-granos`). Probado con la consulta "requisitos para exportar soja a China": los 5 resultados más relevantes fueron, en orden, una resolución de SAGPyA sobre soja/China, la noticia de la convocatoria vigente (con sus anexos), el protocolo bilateral fundacional, más detalle de los anexos de esa misma convocatoria, y una resolución sobre semilla de soja regulada -- ningún resultado fuera de tema. Retrieval semántico funcionando correctamente
  - Nota técnica para quien reproduzca esto: la versión del SDK de Pinecone usada requiere argumentos por *keyword* en `upsert_records` (`namespace=`, `records=`), no posicionales -- varía según versión
- [~] Pipeline incremental
  - [x] Decisión: se migra el proyecto a un repositorio de GitHub (control de
    versiones real, en vez de subir archivos sueltos al Contexto de Claude).
    Por ahora queda **manual** -- no se configura GitHub Actions todavía. Se
    evaluó automatizar con GitHub Actions (gratis e ilimitado en repos
    públicos, 2000 min/mes gratis en privados), pero se decidió posponerlo:
    el Repositorio SENASA depende de PDFs que viven en Google Drive (sin
    acceso directo desde Actions sin credenciales extra) y cambia con muy
    poca frecuencia (normativa histórica), así que automatizarlo no pagaba
    el esfuerzo por ahora. Si se retoma, la parte que más conviene
    automatizar primero son las noticias (`argentina_noticias.py` →
    `chunking.py` → `index_pinecone.py`), que no depende de Drive y sí
    cambia seguido (convocatorias vigentes por país)
  - [x] Crear el repo en GitHub y subir el contenido de este export -- hecho, `coderhouse2025-droid/agroexport-rag` (público). Flujo de trabajo actual: los cambios se aplican en paralelo a la carpeta local y a GitHub (subida manual archivo por archivo vía la web de GitHub cuando no se puede usar `git` desde la máquina local)
  - [ ] Detección de cambios (nuevos vs. modificados) -- no implementada todavía, pendiente de definir alcance
  - [x] Versionado de normas reemplazadas (marcar `vigente: false` en vez de borrar) -- implementado 10/09/2026, ver detalle abajo
- [x] API + frontend -- **en producción**: https://agroexport-rag-repo.vercel.app/. Ver sección "Sesión 10/09/2026" para el detalle de todo lo arreglado
- [~] Validación con usuarios -- guía armada (`guia_validacion_usuarios_ceres_ai.md`, con preguntas de prueba sugeridas y planilla de feedback), **todavía no se corrió** con usuarios reales

## Cómo correr el proyecto

Instalar dependencias:
```
pip install -r requirements.txt
```

Orden de ejecución (cada script tiene sus propios `--argumentos`, correr con
`--help` para ver todas las opciones):
```
python scraper/senasa_repositorio.py          # -> data/raw/senasa_repositorio_index.json
python scraper/downloader.py                  # -> data/processed/senasa_index_con_texto.json (+ PDFs en data/raw/pdfs/, no versionados)
python scraper/extract_text_local.py          # -> data/processed/senasa_index_con_texto_completo.json + data/processed/textos/
python scraper/argentina_noticias.py          # -> data/raw/argentina_noticias_index.json
python scraper/arca_normativa.py              # -> data/raw/arca_normativa_index.json (normativa de ARCA/Aduana)
python scraper/agregar_retenciones_manual.py  # agrega el registro manual de alícuotas de retenciones (ver "Sesión 10/09/2026")
python indexer/chunking.py                    # -> data/processed/chunks.json
python indexer/index_pinecone.py              # sube a Pinecone (requiere PINECONE_API_KEY)
python indexer/query_test.py --pregunta "..." # prueba de retrieval
```

Los PDFs del Repositorio (`data/raw/pdfs/`) y los `.txt` extraídos
(`data/processed/textos/`) no se versionan en git (ver `.gitignore`) por
peso -- viven en Google Drive del autor del proyecto.

---

## API + Frontend: Ceres AI

**Ceres AI** (Agrotech & Export Assistant) es el nombre de la app de chat --
nombre y logo definidos por el autor del proyecto (diosa romana de la
agricultura, guiño directo al dominio). Nombre anterior durante el desarrollo:
"Zarpe" (se mantiene como referencia en el historial de commits, no usar en
adelante).

### Arquitectura

Reusa el mismo stack que Norma-AR, adaptado al dominio de granos:

- **Frontend**: React + Vite (SPA simple, sin necesidad de SSR/rutas).
- **Backend**: función serverless de Vercel (`api/chat.js`) -- mantiene las
  API keys del lado del servidor, nunca expuestas al cliente.
- **Retrieval**: Pinecone, el mismo índice `agroexport-granos` armado en el
  paso de Indexado (inferencia integrada con `llama-text-embed-v2`).
- **Generación**: Groq, modelo `openai/gpt-oss-120b`. **No** se usa Llama 3.3
  -- Groq dio de baja ese modelo en junio 2026 (ver nota en el README de
  Norma-AR); GPT-OSS 120B es el reemplazo recomendado y el que usa Norma-AR
  hoy en producción.
- Respuestas en **streaming** (formato NDJSON: un primer evento con las
  fuentes citables, después el texto token a token).

### Identidad visual

Paleta navy + verde en degradado (del logo provisto), tipografía Space
Grotesk (display) + IBM Plex Sans (cuerpo) + IBM Plex Mono (citas). Cada
norma citada se muestra en una etiqueta con borde izquierdo verde y fondo
suave, distinta a una etiqueta plana genérica -- más sobria que el diseño
anterior de "sello de aduana" (que usaba tipografía Fraunces + papel kraft +
sello rojo punteado), pero manteniendo la idea funcional: cada respuesta debe
mostrar de qué norma sale la información, de forma clara y separada del
texto.

### Variables de entorno

Ver `.env.example` para la lista completa. La única no trivial es
`PINECONE_HOST`: cada índice de Pinecone tiene un host único (no alcanza con
el nombre del índice), se consigue con:
```
python -c "from pinecone import Pinecone; import os; print(Pinecone(api_key=os.environ['PINECONE_API_KEY']).describe_index('agroexport-granos').host)"
```

### Instalación y desarrollo local

```
npm install
```

Las funciones de `/api` no las sirve `vite dev` por sí solo -- para probar
el backend localmente hace falta el CLI de Vercel:
```
npm i -g vercel
vercel dev
```
(`vercel dev` te va a pedir enlazar el proyecto y configurar las variables de
entorno la primera vez -- usa los mismos valores de `.env.example`)

### Deploy

1. Conectar el repo de GitHub a Vercel (vercel.com -> Add New -> Project).
2. En Settings -> Environment Variables, cargar `GROQ_API_KEY`,
   `PINECONE_API_KEY`, `PINECONE_HOST` (aplicadas a Production).
3. Deploy. Vercel detecta Vite automáticamente.

### Validado hasta ahora

- [x] `api/chat.js` compila y se importa sin errores de sintaxis (`node --check`)
- [x] Frontend: `npm install` + `npm run build` corren limpio, sin errores
- [x] Flujo completo end-to-end probado con `vercel --prod` (no `vercel dev` -- se optó por deployar directo a producción y probar ahí en cada iteración)
- [x] **Deploy real a Vercel, en producción**: https://agroexport-rag-repo.vercel.app/
- [x] Validado en mobile real (no solo DevTools) -- ver Fase 6 en "Sesión 10/09/2026"

## Sesión 10/09/2026 — resumen de lo hecho

Sesión larga de arreglos post-deploy inicial. En orden:

1. **Bug de pipes de markdown en las respuestas** (`api/chat.js`): `limpiarTexto()`
   limpiaba pipes solo del *contexto* mandado al modelo, no de la *respuesta* que
   el modelo generaba (streameada directo al cliente sin filtro). Se agregó
   `limpiarDelta()`, aplicado a cada chunk del streaming.
2. **Fase 6 (responsive mobile)**: el sidebar en mobile scrolleaba horizontal
   (nunca se había armado el menú hamburguesa). Ahora es un drawer real con
   overlay (`src/App.jsx` + `src/index.css`), más un breakpoint de 480px y
   fix de auto-zoom de iOS en el input (`font-size: 16px`). Validado en
   celular real.
3. **`NORMAS_CANDIDATAS` ampliada** (`scraper/arca_normativa.py`): se
   agregaron los decretos de derechos de exportación vigentes (877/2025 y
   423/2026) y se confirmaron 2 normas que habían quedado sin validar
   (Ley 21.453, RG 128/2019).
4. **Bug de desfasaje de archivos**: `chunking.py` guarda en `chunks.json`
   por default, pero `index_pinecone.py` leía `chunks_completo.json` (un
   snapshot viejo) por default -- se corrigieron para que coincidan.
5. **Bug de parsing de tablas HTML** (`arca_normativa.py`): `_limpiar_html_a_texto`
   no separaba celdas de `<table>`, dejando texto tipo `"Soja24%Trigo5,5%"`
   todo pegado -- roto tanto para lectura humana como para el embedding
   semántico. Se agregó separación de celdas/filas.
6. **Detección de `cultivos` para normas de ARCA** (`chunking.py`): antes
   quedaba siempre en `[]`.
7. **Hallazgo importante**: los decretos de retenciones (877/2025, 423/2026)
   fijan las alícuotas remitiendo a Anexos adjuntos por sistema GDE
   (`IF-2026-...-APN-SSMAEII#MEC`) **sin URL pública descargable**. El texto
   del decreto scrapeado nunca tiene el número concreto (confirmado: la
   palabra "Alícuota" no aparece ni una vez en el texto del Decreto
   423/2026). Se resolvió con un registro manual curado
   (`scraper/agregar_retenciones_manual.py`) que cruza 3 fuentes
   periodísticas coincidentes (La Nación, Infobae, Infocampo) y cita el
   Boletín Oficial para que cualquiera lo verifique. El texto se escribió
   arrancando directo con el dato útil (no con la aclaración metodológica),
   porque un chunk que arranca con "Nota: este es un resumen elaborado a
   mano..." rankea peor semánticamente para preguntas tipo "cuánto pago de
   retenciones" que uno que arranca con "Trigo y cebada: la alícuota bajó...".
8. **`TOP_K` subido de 6 a 8** en `api/chat.js` -- los scores de este corpus
   rondan 0.33-0.47 en general (sin separación fuerte entre chunks
   relevantes e irrelevantes), así que candidatos relevantes se estaban
   quedando afuera del top 6 con preguntas de fraseo natural.
9. **Versionado de normas, implementado**: `detectar_derogaciones()` en
   `chunking.py` escanea el texto completo de cada norma buscando patrones
   tipo "Derógase la Resolución N° X/AAAA"; si esa norma referenciada está
   en el propio corpus, la marca `vigente: false` con quién la derogó y la
   oración exacta como evidencia. Diseño a propósito conservador: nunca
   marca `vigente: true`, solo `false` (con evidencia) o `null` (no
   verificado) -- evita falsos positivos que serían activamente engañosos.
   El prompt del chat avisa explícitamente si va a citar una norma marcada
   como derogada, y el frontend muestra un sello rojo "⚠ Derogada". Sobre
   el corpus actual (1951 chunks, ~86 documentos únicos) dio 0 derogaciones
   detectadas -- resultado válido y esperado dado el tamaño del corpus, no
   un bug; la función se activa sola a futuro si aparece una norma que
   derogue algo que ya tengamos indexado.
10. Se generó una guía de validación con usuarios reales
    (`guia_validacion_usuarios_ceres_ai.md`): preguntas de prueba sugeridas
    por área + planilla de feedback. Todavía no se corrió con usuarios
    reales -- ver "Pendientes" abajo.

## Pendientes (al cierre de la sesión 10/09/2026)

- [ ] **Validación con usuarios reales** -- guía lista, falta juntar 2-3
  exportadores/despachantes y correr las pruebas.
- [ ] Automatizar `pais_destino`/`cultivos` de noticias (hoy hardcodeado a
  mano, son pocas)
- [ ] Resolución de acceso al Digesto Normativo SENASA (bloqueado por
  robots.txt)
- [ ] Conseguir acceso real al texto de los Anexos de alícuotas de ARCA (hoy
  resuelto vía fuentes periodísticas, no la fuente primaria) -- si en algún
  momento se consigue el PDF real (pedido directo al Boletín Oficial, o
  procesado con `extract_text_local.py` si alguien lo baja a mano),
  reemplazar el registro manual por la fuente primaria
- [ ] Detección de cambios incremental (altas/bajas automáticas en las
  fuentes) -- no implementada, pendiente de definir alcance
- [ ] Evaluar automatizar el pipeline con GitHub Actions (evaluado y
  pospuesto, ver más arriba)
