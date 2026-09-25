
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

// Fecha de la última corrida de `index_pinecone.py` que quedó en producción. Se actualiza
// a mano después de cada reindex (no hay forma de saberlo automáticamente desde el
// frontend, que no tiene acceso a Pinecone). Formato: "DD/MM/AAAA".
const ULTIMA_ACTUALIZACION_NORMATIVA = "21/09/2026";

const PREGUNTAS_EJEMPLO = [
  "¿Qué necesito para exportar soja a China?",
  "¿Cuáles son los requisitos para exportar trigo a Brasil?",
  "¿Qué es el Anexo III de la convocatoria de granos a China?",
];

const NAV_ITEMS = [
  { id: "inicio", label: "Inicio", icono: "🏠", activo: true },
  { id: "historial", label: "Historial", icono: "🕘", activo: true },
  { id: "favoritos", label: "Favoritos", icono: "⭐", activo: true },
];

// Historial de consultas: se guarda en localStorage del navegador (no hay backend ni
// cuentas de usuario en la app), por eso es local a cada dispositivo/navegador, no
// compartido entre dispositivos ni visible para otra persona. Se guarda solo cuando la
// respuesta terminó sin error (ver enviarPregunta). Tope de 30 para no inflar
// localStorage con años de uso.
const HISTORIAL_KEY = "ceres_historial_v1";
const HISTORIAL_MAX = 30;

function cargarHistorial() {
  try {
    const crudo = localStorage.getItem(HISTORIAL_KEY);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    return Array.isArray(datos) ? datos : [];
  } catch {
    return [];
  }
}

function guardarHistorial(items) {
  try {
    localStorage.setItem(HISTORIAL_KEY, JSON.stringify(items.slice(0, HISTORIAL_MAX)));
  } catch {
    // localStorage lleno o bloqueado (modo privado, etc.): la app sigue funcionando,
    // simplemente no persiste el historial en ese caso.
  }
}

// Favoritos: a diferencia del Historial (que guarda automáticamente cada consulta
// completa), acá se guardan normas puntuales que el usuario elige marcar desde los
// sellos de cualquier respuesta -- para armar una carpeta de normativa de referencia,
// no un registro de preguntas. También en localStorage, local a este navegador.
const FAVORITOS_KEY = "ceres_favoritos_v1";
const FAVORITOS_MAX = 200; // guardado manual, pero con un techo defensivo igual

// Identificador estable de una fuente para saber si ya está guardada: se prioriza la
// url (más único); si no hay url, se arma con tipo+organismo+número+año, y si tampoco
// hay numeroNorma (una noticia sin url, caso raro), se cae al título.
function idFuente(f) {
  if (f.url) return f.url;
  if (f.numeroNorma) return `${f.tipoNorma ?? ""}|${f.organismoEmisor ?? ""}|${f.numeroNorma}|${f.anio ?? ""}`;
  return `titulo:${f.titulo}`;
}

function cargarFavoritos() {
  try {
    const crudo = localStorage.getItem(FAVORITOS_KEY);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    return Array.isArray(datos) ? datos : [];
  } catch {
    return [];
  }
}

function guardarFavoritos(items) {
  try {
    localStorage.setItem(FAVORITOS_KEY, JSON.stringify(items.slice(0, FAVORITOS_MAX)));
  } catch {
    // ver comentario equivalente en guardarHistorial
  }
}

function Sidebar({ abierto, onCerrar, vista, onSeleccionar }) {
  return (
    <aside className={`sidebar ${abierto ? "sidebar-abierto" : ""}`}>
      <button className="sidebar-cerrar" onClick={onCerrar} aria-label="Cerrar menú">
        ✕
      </button>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) =>
          item.activo ? (
            <button
              key={item.id}
              type="button"
              className={`sidebar-item sidebar-item-boton ${vista === item.id ? "sidebar-item-activo" : ""}`}
              onClick={() => {
                onSeleccionar(item.id);
                onCerrar();
              }}
            >
              <span className="sidebar-icono">{item.icono}</span>
              {item.label}
            </button>
          ) : (
            <div key={item.id} className="sidebar-item sidebar-item-disabled" title="Próximamente">
              <span className="sidebar-icono">{item.icono}</span>
              {item.label}
              <span className="sidebar-proximamente">Pronto</span>
            </div>
          )
        )}
      </nav>
      <div className="sidebar-confianza">
        <p className="sidebar-confianza-titulo">🛡️ Información confiable</p>
        <p className="sidebar-confianza-texto">
          Respuestas basadas en normativa oficial y fuentes verificadas.
        </p>
      </div>
    </aside>
  );
}

function Topbar({ onAbrirMenu }) {
  return (
    <div className="topbar">
      <div className="topbar-marca">
        <button className="hamburger-btn" onClick={onAbrirMenu} aria-label="Abrir menú">
          <span />
          <span />
          <span />
        </button>
        <img src="/logo.png" alt="Ceres AI" className="topbar-logo" />
        <div className="topbar-textos">
          <span className="topbar-titulo">Ceres AI</span>
          <span className="topbar-tagline">Agrotech &amp; Export Assistant</span>
        </div>
      </div>
      <div className="topbar-fuentes">
        <span className="topbar-fuente">
          <span className="topbar-fuente-dot topbar-fuente-dot-ok" />
          SENASA
        </span>
        <span className="topbar-fuente">
          <span className="topbar-fuente-dot topbar-fuente-dot-ok" />
          Aduana/ARCA
        </span>
      </div>
    </div>
  );
}

function ResumenConsulta({ resumen, ultimaPregunta }) {
  return (
    <div className="panel-info">
      <p className="panel-info-titulo">📋 Resumen de la consulta</p>
      {resumen ? (
        <p className="panel-info-texto">{resumen}</p>
      ) : ultimaPregunta ? (
        <p className="panel-info-texto panel-info-texto-vacio">{ultimaPregunta} (generando resumen…)</p>
      ) : (
        <p className="panel-info-texto panel-info-texto-vacio">
          Acá vas a ver la última consulta que hiciste.
        </p>
      )}
    </div>
  );
}

function NormativaRelacionada({ fuentes }) {
  return (
    <div className="panel-info">
      <p className="panel-info-titulo">⚖️ Normativa relacionada</p>
      {fuentes && fuentes.length > 0 ? (
        <ul className="panel-info-lista">
          {fuentes.map((f, i) => {
            const etiqueta = f.numeroNorma
              ? `${f.tipoNorma} ${f.organismoEmisor ?? ""} N° ${f.numeroNorma}`.trim()
              : f.titulo;
            return (
              <li key={i}>
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noreferrer">
                    {etiqueta}
                  </a>
                ) : (
                  etiqueta
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="panel-info-texto panel-info-texto-vacio">
          Se va a completar con la normativa citada en tu próxima consulta.
        </p>
      )}
    </div>
  );
}

function FuentesPanel() {
  return (
    <div className="panel-info">
      <p className="panel-info-titulo">🗄️ Fuentes</p>
      <div className="panel-info-fuente-item">
        <span>SENASA</span>
        <span className="panel-info-check-ok">✓</span>
      </div>
      <div className="panel-info-fuente-item">
        <span>Aduana / ARCA</span>
        <span className="panel-info-check-ok">✓</span>
      </div>
    </div>
  );
}

function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Conversión mínima de markdown a HTML para la página de descarga, que es un documento
// standalone (no puede usar ReactMarkdown, que solo corre dentro de la app de React).
// Alcanza con negrita, listas y saltos de línea: es lo único que usa el prompt de
// Ceres AI en sus respuestas (ver armarPromptSistema en api/chat.js).
function mdBasicoAHtml(md) {
  const lineas = escapeHtml(md).split("\n");
  let html = "";
  let enLista = false;
  for (const linea of lineas) {
    const esItem = /^[-*]\s+/.test(linea);
    if (esItem && !enLista) {
      html += "<ul>";
      enLista = true;
    } else if (!esItem && enLista) {
      html += "</ul>";
      enLista = false;
    }
    const contenido = linea.replace(/^[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html += esItem ? `<li>${contenido}</li>` : linea.trim() === "" ? "<br>" : `<p>${contenido}</p>`;
  }
  if (enLista) html += "</ul>";
  return html;
}

// Arma una página HTML autocontenida con la pregunta, la respuesta y las fuentes, y la
// abre en una pestaña nueva con un botón para descargarla como archivo (.html, se puede
// abrir con doble clic o imprimir a PDF desde el navegador). Se usa un Blob URL en vez de
// window.print() directo porque así el usuario puede releerla, guardarla o imprimirla
// cuando quiera, no solo en el momento de tocar el botón.
function abrirDescarga(pregunta, mensaje) {
  const fecha = new Date().toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const fuentesHtml = (mensaje.fuentes || [])
    .map((f) => {
      const etiqueta = f.numeroNorma
        ? `${f.tipoNorma ?? ""} ${f.organismoEmisor ?? ""} N° ${f.numeroNorma}`.trim()
        : f.titulo;
      const texto = escapeHtml(`${f.fuente === "noticia" ? "Comunicado" : "Norma"} — ${etiqueta}${f.anio ? ` (${f.anio})` : ""}${f.vigente === false ? " [DEROGADA]" : ""}`);
      return f.url
        ? `<li><a href="${escapeHtml(f.url)}" target="_blank" rel="noreferrer">${texto}</a></li>`
        : `<li>${texto}</li>`;
    })
    .join("");

  const nombreArchivo = `ceres-ai-consulta-${new Date().toISOString().slice(0, 10)}.html`;

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Ceres AI — Consulta guardada</title>
<style>
  :root {
    --fondo: #f7f9f8; --panel: #ffffff; --navy: #10213f; --navy-suave: #4a5875;
    --verde-oscuro: #1a8f4c; --borde: #e1e6e3; --acento-suave: #eaf7ee;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px; background: var(--fondo); color: var(--navy);
    font-family: "IBM Plex Sans", -apple-system, sans-serif; line-height: 1.55;
  }
  .doc { max-width: 720px; margin: 0 auto; background: var(--panel); border: 1px solid var(--borde);
    border-radius: 12px; padding: 32px; }
  .marca { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  .marca-nombre { font-weight: 700; font-size: 1.05rem; }
  .fecha { font-size: 0.78rem; color: var(--navy-suave); }
  .pregunta { font-size: 1.1rem; font-weight: 700; margin: 0 0 16px; }
  .respuesta p { margin: 0 0 10px; }
  .respuesta ul { margin: 0 0 10px; padding-left: 20px; }
  .fuentes { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--borde); }
  .fuentes h2 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--verde-oscuro); margin: 0 0 8px; }
  .fuentes ul { margin: 0; padding-left: 18px; font-size: 0.85rem; }
  .fuentes a { color: var(--navy); }
  .aviso { margin-top: 20px; font-size: 0.75rem; color: var(--navy-suave); }
  .acciones { max-width: 720px; margin: 16px auto 0; display: flex; gap: 10px; }
  button { font-family: inherit; font-size: 0.85rem; padding: 9px 16px; border-radius: 8px;
    border: 1px solid var(--borde); background: var(--panel); color: var(--navy); cursor: pointer; }
  button.primario { background: var(--verde-oscuro); border-color: var(--verde-oscuro); color: #fff; }
  @media print { .acciones { display: none; } body { background: #fff; padding: 0; } .doc { border: none; } }
</style>
</head>
<body>
  <div class="doc">
    <div class="marca">
      <span class="marca-nombre">🌾 Ceres AI</span>
      <span class="fecha">${escapeHtml(fecha)}</span>
    </div>
    <p class="pregunta">${escapeHtml(pregunta)}</p>
    <div class="respuesta">${mdBasicoAHtml(mensaje.content)}</div>
    ${fuentesHtml ? `<div class="fuentes"><h2>Fuentes</h2><ul>${fuentesHtml}</ul></div>` : ""}
    <p class="aviso">Respuesta generada por Ceres AI a partir de normativa oficial. Verificá siempre con SENASA/ARCA antes de operar.</p>
  </div>
  <div class="acciones">
    <button class="primario" id="btn-descargar">⬇️ Descargar como archivo</button>
    <button id="btn-imprimir">🖨️ Imprimir / Guardar como PDF</button>
  </div>
  <script>
    document.getElementById("btn-descargar").addEventListener("click", function () {
      var blob = new Blob([document.documentElement.outerHTML], { type: "text/html" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = ${JSON.stringify(nombreArchivo)};
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
    document.getElementById("btn-imprimir").addEventListener("click", function () {
      window.print();
    });
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  // se revoca después de un rato, no de inmediato, para darle tiempo a la pestaña nueva
  // a terminar de cargar el recurso antes de invalidar la URL
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// A qué organismo corresponde una fuente, solo para agruparlas visualmente (no cambia
// qué se recupera ni qué dice la respuesta). fuente.fuente === "arca" siempre es ARCA.
// El corpus de "noticias" mezcla comunicados de SENASA (protocolo China, ePhyto Brasil)
// con el registro de retenciones (agregado a mano, ver scraper/agregar_retenciones_manual.py),
// que es un tema aduanero/impositivo aunque esté guardado en el mismo bucket -- por eso
// se distingue también por palabras clave del título, no solo por el campo "fuente".
const RE_TEMATICA_ARCA = /retenci|derechos?\s+de\s+exportaci|al[ií]cuota|aduaner|\barca\b/i;

function organismoDe(fuente) {
  if (fuente.fuente === "arca") return "arca";
  if (fuente.fuente === "noticia" && RE_TEMATICA_ARCA.test(fuente.titulo || "")) return "arca";
  return "senasa";
}

function etiquetaFuente(fuente) {
  return fuente.numeroNorma
    ? `${fuente.tipoNorma ?? ""} ${fuente.organismoEmisor ?? ""} N° ${fuente.numeroNorma}`.trim()
    : fuente.titulo;
}

function Sello({ fuente, esFavorito, onAlternarFavorito, onAbrirFicha }) {
  const estrella = (
    <button
      type="button"
      className={`sello-favorito ${esFavorito ? "sello-favorito-activo" : ""}`}
      onClick={(e) => {
        e.stopPropagation(); // no abrir también la ficha al tocar la estrella
        onAlternarFavorito(fuente);
      }}
      title={esFavorito ? "Quitar de favoritos" : "Guardar en favoritos"}
      aria-label={esFavorito ? "Quitar de favoritos" : "Guardar en favoritos"}
    >
      {esFavorito ? "★" : "☆"}
    </button>
  );

  return (
    <button
      type="button"
      className={`sello sello-boton ${fuente.vigente === false ? "sello-derogada" : ""}`}
      onClick={() => onAbrirFicha(fuente)}
    >
      <span className="sello-tipo">
        {fuente.fuente === "noticia" ? "Comunicado" : "Norma"}
      </span>
      <span className="sello-texto">{etiquetaFuente(fuente)}</span>
      {fuente.anio && <span className="sello-anio">{fuente.anio}</span>}
      {fuente.vigente === false && (
        <span className="sello-derogada-badge" title={fuente.derogadaPorTitulo ? `Derogada por: ${fuente.derogadaPorTitulo}` : "Derogada"}>
          ⚠ Derogada
        </span>
      )}
      {estrella}
    </button>
  );
}

function GrupoSellos({ fuentes, favoritosIds, onAlternarFavorito, onAbrirFicha }) {
  const senasa = fuentes.filter((f) => organismoDe(f) === "senasa");
  const arca = fuentes.filter((f) => organismoDe(f) === "arca");
  const sellosDe = (lista) =>
    lista.map((f, i) => (
      <Sello
        key={i}
        fuente={f}
        esFavorito={favoritosIds.has(idFuente(f))}
        onAlternarFavorito={onAlternarFavorito}
        onAbrirFicha={onAbrirFicha}
      />
    ));

  // Cuando hay fuentes de un solo organismo (el caso más común), se muestra la lista
  // simple de siempre, sin encabezados que serían redundantes con un solo grupo.
  if (senasa.length === 0 || arca.length === 0) {
    return <div className="sellos-container">{sellosDe(fuentes)}</div>;
  }

  return (
    <div className="sellos-container sellos-agrupados">
      <div className="sellos-grupo">
        <span className="sellos-grupo-titulo">🌿 SENASA — Requisitos fitosanitarios</span>
        <div className="sellos-grupo-lista">{sellosDe(senasa)}</div>
      </div>
      <div className="sellos-grupo">
        <span className="sellos-grupo-titulo">🛃 ARCA — Requisitos aduaneros</span>
        <div className="sellos-grupo-lista">{sellosDe(arca)}</div>
      </div>
    </div>
  );
}

function FichaNormaModal({ fuente, esFavorito, onAlternarFavorito, onCerrar }) {
  const organismo = organismoDe(fuente);
  return (
    <div className="ficha-overlay" onClick={onCerrar}>
      <div className="ficha-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ficha-header">
          <span className={`ficha-organismo ficha-organismo-${organismo}`}>
            {organismo === "arca" ? "🛃 ARCA" : "🌿 SENASA"}
          </span>
          <button type="button" className="ficha-cerrar" onClick={onCerrar} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <h3 className="ficha-titulo">{etiquetaFuente(fuente)}</h3>

        <dl className="ficha-datos">
          <dt>Tipo</dt>
          <dd>{fuente.fuente === "noticia" ? "Comunicado" : fuente.tipoNorma || "Norma"}</dd>
          {fuente.organismoEmisor && (
            <>
              <dt>Organismo emisor</dt>
              <dd>{fuente.organismoEmisor}</dd>
            </>
          )}
          {fuente.anio && (
            <>
              <dt>Año</dt>
              <dd>{fuente.anio}</dd>
            </>
          )}
          <dt>Estado</dt>
          <dd>
            {fuente.vigente === false ? (
              <span className="ficha-estado ficha-estado-derogada">
                ⚠ Derogada{fuente.derogadaPorTitulo ? ` — reemplazada por: ${fuente.derogadaPorTitulo}` : ""}
              </span>
            ) : (
              <span className="ficha-estado ficha-estado-no-verificado">
                No verificado — consultá la fuente oficial antes de operar
              </span>
            )}
          </dd>
        </dl>

        {fuente.fragmento && (
          <div className="ficha-fragmento">
            <span className="ficha-fragmento-titulo">Fragmento citado</span>
            <p>“{fuente.fragmento}”</p>
          </div>
        )}

        <div className="ficha-acciones">
          <button
            type="button"
            className={`ficha-favorito ${esFavorito ? "ficha-favorito-activo" : ""}`}
            onClick={() => onAlternarFavorito(fuente)}
          >
            {esFavorito ? "★ Guardada en favoritos" : "☆ Guardar en favoritos"}
          </button>
          {fuente.url && (
            <a href={fuente.url} target="_blank" rel="noreferrer" className="ficha-link">
              Ver norma oficial ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Mensaje({ mensaje, pregunta, seEstaGenerando, favoritosIds, onAlternarFavorito, onAbrirFicha }) {
  const esUsuario = mensaje.role === "user";
  // se puede descargar solo cuando la respuesta ya terminó (no a mitad del streaming)
  const puedeDescargar = !esUsuario && !seEstaGenerando && mensaje.content.trim().length > 0;
  return (
    <div className={`mensaje ${esUsuario ? "mensaje-usuario" : "mensaje-asistente"}`}>
      <div className="mensaje-burbuja">
        {esUsuario ? (
          <p>{mensaje.content}</p>
        ) : (
          <ReactMarkdown>{mensaje.content || "…"}</ReactMarkdown>
        )}
      </div>
      {!esUsuario && mensaje.fuentes && mensaje.fuentes.length > 0 && (
        <GrupoSellos
          fuentes={mensaje.fuentes}
          favoritosIds={favoritosIds}
          onAlternarFavorito={onAlternarFavorito}
          onAbrirFicha={onAbrirFicha}
        />
      )}
      {puedeDescargar && (
        <button
          type="button"
          className="mensaje-descargar"
          onClick={() => abrirDescarga(pregunta ?? "", mensaje)}
        >
          ⬇️ Descargar esta consulta
        </button>
      )}
    </div>
  );
}

// Solo para la vista previa de 2 líneas del historial: la respuesta completa se sigue
// mostrando con ReactMarkdown (componente Mensaje) al reabrir la consulta. Acá alcanza con
// sacar los símbolos más comunes para que no se vean asteriscos/almohadillas sueltos.
function textoPlanoPreview(md) {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

// Etiqueta "🌾 Soja → China" para las tarjetas de Historial: es una detección por
// palabra clave sobre el TEXTO de la pregunta guardada, solo para mostrar de un
// vistazo de qué fue la consulta. No es un dato verificado del corpus (el corpus no
// tiene "producto" y "destino" como campos estructurados) -- por eso, si no matchea
// nada, no se muestra ninguna etiqueta en vez de forzar una.
const CULTIVOS_ETIQUETA = [
  { re: /\bsoja\b/i, emoji: "🟢", label: "Soja" },
  { re: /\bma[ií]z\b/i, emoji: "🌽", label: "Maíz" },
  { re: /\btrigo\b/i, emoji: "🌾", label: "Trigo" },
  { re: /\bcebada\b/i, emoji: "🌾", label: "Cebada" },
  { re: /\bsorgo\b/i, emoji: "🌾", label: "Sorgo" },
  { re: /\bgirasol(es)?\b/i, emoji: "🌻", label: "Girasol" },
];
const PAISES_ETIQUETA = [
  { re: /\bchina\b/i, label: "China" },
  { re: /\bbrasil\b/i, label: "Brasil" },
  { re: /\b(uni[oó]n europea|\bue\b|espa[ñn]a)\b/i, label: "UE" },
  { re: /\bindia\b/i, label: "India" },
  { re: /\bvietnam\b/i, label: "Vietnam" },
  { re: /\bchile\b/i, label: "Chile" },
  { re: /\b(estados unidos|eeuu|ee\.\s?uu\.?)\b/i, label: "EE. UU." },
];

function detectarEtiquetaOperacion(pregunta) {
  const cultivo = CULTIVOS_ETIQUETA.find((c) => c.re.test(pregunta));
  const pais = PAISES_ETIQUETA.find((p) => p.re.test(pregunta));
  if (!cultivo && !pais) return null;
  return {
    emoji: cultivo?.emoji ?? "📌",
    texto: [cultivo?.label, pais?.label].filter(Boolean).join(" → "),
  };
}

function HistorialItem({ item, onAbrir, onEliminar }) {
  const etiqueta = detectarEtiquetaOperacion(item.pregunta);
  const fecha = new Date(item.fecha).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="historial-item">
      <button type="button" className="historial-item-principal" onClick={() => onAbrir(item)}>
        {etiqueta && (
          <span className="historial-item-etiqueta">
            {etiqueta.emoji} {etiqueta.texto}
          </span>
        )}
        <span className="historial-item-pregunta">{item.pregunta}</span>
        <span className="historial-item-respuesta">{textoPlanoPreview(item.respuesta)}</span>
        <span className="historial-item-fecha">{fecha}</span>
      </button>
      <button
        type="button"
        className="historial-item-borrar"
        onClick={() => onEliminar(item.id)}
        aria-label="Eliminar esta consulta del historial"
        title="Eliminar"
      >
        🗑️
      </button>
    </div>
  );
}

function HistorialView({ items, onAbrir, onEliminar, onVaciar }) {
  if (items.length === 0) {
    return (
      <section className="historial-vacio">
        <p className="historial-vacio-titulo">Todavía no hay consultas guardadas</p>
        <p className="historial-vacio-texto">
          Cada consulta que respondas en Inicio va a aparecer acá, guardada en este navegador.
        </p>
      </section>
    );
  }
  return (
    <section className="historial-lista-wrap">
      <div className="historial-header">
        <h2 className="historial-titulo">Historial de consultas</h2>
        <button type="button" className="historial-vaciar" onClick={onVaciar}>
          Vaciar historial
        </button>
      </div>
      <div className="historial-lista">
        {items.map((item) => (
          <HistorialItem key={item.id} item={item} onAbrir={onAbrir} onEliminar={onEliminar} />
        ))}
      </div>
    </section>
  );
}

function FavoritoItem({ item, onEliminar }) {
  const etiqueta = item.numeroNorma
    ? `${item.tipoNorma ?? ""} ${item.organismoEmisor ?? ""} N° ${item.numeroNorma}`.trim()
    : item.titulo;
  const fecha = new Date(item.fechaGuardado).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return (
    <div className={`favorito-item ${item.vigente === false ? "favorito-item-derogada" : ""}`}>
      <div className="favorito-item-principal">
        <span className="favorito-item-tipo">{item.fuente === "noticia" ? "Comunicado" : "Norma"}</span>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" className="favorito-item-titulo">
            {etiqueta}
          </a>
        ) : (
          <span className="favorito-item-titulo">{etiqueta}</span>
        )}
        {item.anio && <span className="favorito-item-anio">{item.anio}</span>}
        {item.vigente === false && (
          <span
            className="sello-derogada-badge"
            title={item.derogadaPorTitulo ? `Derogada por: ${item.derogadaPorTitulo}` : "Derogada"}
          >
            ⚠ Derogada
          </span>
        )}
        <span className="favorito-item-fecha">Guardada el {fecha}</span>
      </div>
      <button
        type="button"
        className="historial-item-borrar"
        onClick={() => onEliminar(idFuente(item))}
        aria-label="Quitar de favoritos"
        title="Quitar de favoritos"
      >
        🗑️
      </button>
    </div>
  );
}

function FavoritosView({ items, onEliminar }) {
  if (items.length === 0) {
    return (
      <section className="historial-vacio">
        <p className="historial-vacio-titulo">Todavía no guardaste ninguna norma</p>
        <p className="historial-vacio-texto">
          Tocá la estrella ☆ en cualquier sello de una respuesta para guardar esa norma acá,
          como referencia rápida para más adelante.
        </p>
      </section>
    );
  }
  return (
    <section className="historial-lista-wrap">
      <div className="historial-header">
        <h2 className="historial-titulo">Normativa guardada</h2>
      </div>
      <div className="historial-lista">
        {items.map((item) => (
          <FavoritoItem key={idFuente(item)} item={item} onEliminar={onEliminar} />
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [mensajes, setMensajes] = useState([]);
  const [input, setInput] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [vista, setVista] = useState("inicio");
  const [historial, setHistorial] = useState([]);
  const [favoritos, setFavoritos] = useState([]);
  const [fichaAbierta, setFichaAbierta] = useState(null);
  const finRef = useRef(null);

  useEffect(() => {
    setHistorial(cargarHistorial());
    setFavoritos(cargarFavoritos());
  }, []);

  const favoritosIds = new Set(favoritos.map(idFuente));

  function alternarFavorito(fuente) {
    const id = idFuente(fuente);
    setFavoritos((prev) => {
      const yaEsta = prev.some((f) => idFuente(f) === id);
      const actualizado = yaEsta
        ? prev.filter((f) => idFuente(f) !== id)
        : [{ ...fuente, fechaGuardado: new Date().toISOString() }, ...prev];
      guardarFavoritos(actualizado);
      return actualizado;
    });
  }

  function eliminarFavorito(id) {
    setFavoritos((prev) => {
      const actualizado = prev.filter((f) => idFuente(f) !== id);
      guardarFavoritos(actualizado);
      return actualizado;
    });
  }

  // La consulta que se acaba de responder ya quedó guardada sola en el Historial (ver más
  // arriba): "nueva consulta" solo limpia lo que se ve en pantalla para arrancar de cero,
  // no borra nada del historial ni de favoritos.
  function nuevaConsulta() {
    setMensajes([]);
    setError(null);
    setInput("");
  }

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes]);

  async function enviarPregunta(pregunta) {
    if (!pregunta.trim() || cargando) return;
    setError(null);

    const historialPrevio = mensajes.map((m) => ({ role: m.role, content: m.content }));
    const nuevosMensajes = [
      ...mensajes,
      { role: "user", content: pregunta.trim() },
      { role: "assistant", content: "", fuentes: [] },
    ];
    setMensajes(nuevosMensajes);
    setInput("");
    setCargando(true);

    // acumuladores locales, en paralelo al estado de React (ver comentario de guardado abajo)
    let respuestaFinal = "";
    let fuentesFinal = [];
    let resumenFinal = "";

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pregunta: pregunta.trim(), historial: historialPrevio }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Error ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lineas = buffer.split("\n");
        buffer = lineas.pop() || "";

        for (const linea of lineas) {
          if (!linea.trim()) continue;
          const evento = JSON.parse(linea);

          if (evento.tipo === "fuentes") {
            fuentesFinal = evento.fuentes;
            setMensajes((prev) => {
              const copia = [...prev];
              copia[copia.length - 1] = { ...copia[copia.length - 1], fuentes: evento.fuentes };
              return copia;
            });
          } else if (evento.tipo === "texto") {
            respuestaFinal += evento.contenido;
            setMensajes((prev) => {
              const copia = [...prev];
              const ultimo = copia[copia.length - 1];
              copia[copia.length - 1] = { ...ultimo, content: ultimo.content + evento.contenido };
              return copia;
            });
          } else if (evento.tipo === "resumen") {
            resumenFinal = evento.contenido;
            setMensajes((prev) => {
              const copia = [...prev];
              copia[copia.length - 1] = { ...copia[copia.length - 1], resumen: evento.contenido };
              return copia;
            });
          } else if (evento.tipo === "error") {
            setError(evento.mensaje);
          }
        }
      }
      // Guardar en el historial solo si terminó sin error y hay algo de texto (una
      // respuesta vacía, p. ej. si el usuario cortó la carga, no aporta nada guardada).
      if (respuestaFinal.trim()) {
        const entrada = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fecha: new Date().toISOString(),
          pregunta: pregunta.trim(),
          respuesta: respuestaFinal,
          fuentes: fuentesFinal,
          resumen: resumenFinal,
        };
        setHistorial((prev) => {
          const actualizado = [entrada, ...prev].slice(0, HISTORIAL_MAX);
          guardarHistorial(actualizado);
          return actualizado;
        });
      }
    } catch (err) {
      setError(err.message || "No se pudo generar la respuesta.");
    } finally {
      setCargando(false);
    }
  }

  function abrirDesdeHistorial(item) {
    setMensajes([
      { role: "user", content: item.pregunta },
      { role: "assistant", content: item.respuesta, fuentes: item.fuentes, resumen: item.resumen },
    ]);
    setVista("inicio");
  }

  function eliminarDelHistorial(id) {
    setHistorial((prev) => {
      const actualizado = prev.filter((h) => h.id !== id);
      guardarHistorial(actualizado);
      return actualizado;
    });
  }

  function vaciarHistorial() {
    setHistorial([]);
    guardarHistorial([]);
  }

  function onSubmit(e) {
    e.preventDefault();
    enviarPregunta(input);
  }

  const ultimoMensajeAsistente = [...mensajes].reverse().find((m) => m.role === "assistant" && m.fuentes?.length > 0);
  const ultimoMensajeConResumen = [...mensajes].reverse().find((m) => m.role === "assistant" && m.resumen);
  const ultimaPreguntaUsuario = [...mensajes].reverse().find((m) => m.role === "user");

  return (
    <div className="app-shell">
      <Topbar onAbrirMenu={() => setMenuAbierto(true)} />
      <div className="app-body">
        <Sidebar
          abierto={menuAbierto}
          onCerrar={() => setMenuAbierto(false)}
          vista={vista}
          onSeleccionar={setVista}
        />
        {menuAbierto && <div className="sidebar-overlay" onClick={() => setMenuAbierto(false)} />}

        <main className="app-main">
          {vista === "historial" ? (
            <HistorialView
              items={historial}
              onAbrir={abrirDesdeHistorial}
              onEliminar={eliminarDelHistorial}
              onVaciar={vaciarHistorial}
            />
          ) : vista === "favoritos" ? (
            <FavoritosView items={favoritos} onEliminar={eliminarFavorito} />
          ) : (
          <>
          <div className="dashboard-grid">
            <section className="hero-col">
              <h1 className="hero-titulo">
                Asistente inteligente
                <span className="hero-titulo-verde"> para exportación de granos</span>
              </h1>
              <p className="hero-texto">
                Consultá requisitos SENASA, aduaneros y fitosanitarios con información
                normativa respaldada por fuentes.
              </p>
              <div className="hero-badge">🔒 RAG · Normativa oficial</div>
            </section>

            <section className="chat-col">
              <div className="chat-col-header">
                <span>Consulta normativa</span>
                <span className="chat-col-header-derecha">
                  {mensajes.length > 0 && (
                    <button type="button" className="chat-col-nueva" onClick={nuevaConsulta}>
                      🗑️ Nueva consulta
                    </button>
                  )}
                  <span className="chat-col-estado">
                    <span className="chat-col-estado-dot" />
                    En línea
                  </span>
                </span>
              </div>

              <main className="chat">
                {mensajes.length === 0 ? (
                  <div className="estado-vacio">
                    <p className="estado-vacio-texto">
                      Hola. Soy Ceres AI. ¿Qué producto y destino deseas consultar hoy?
                    </p>
                    <div className="chips">
                      {PREGUNTAS_EJEMPLO.map((p) => (
                        <button key={p} className="chip" onClick={() => enviarPregunta(p)}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mensajes">
                    {mensajes.map((m, i) => (
                      <Mensaje
                        key={i}
                        mensaje={m}
                        pregunta={m.role !== "user" ? mensajes[i - 1]?.content : undefined}
                        seEstaGenerando={cargando && i === mensajes.length - 1}
                        favoritosIds={favoritosIds}
                        onAlternarFavorito={alternarFavorito}
                        onAbrirFicha={setFichaAbierta}
                      />
                    ))}
                    <div ref={finRef} />
                  </div>
                )}

                {error && <div className="error-banner">{error}</div>}
              </main>

              <form className="input-bar" onSubmit={onSubmit}>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Escribí tu consulta..."
                  maxLength={500}
                  disabled={cargando}
                />
                <button type="submit" disabled={cargando || !input.trim()}>
                  {cargando ? "…" : "Enviar"}
                </button>
              </form>
              <p className="chat-col-disclaimer">
                Las respuestas pueden contener referencias a normativa oficial. Verificá siempre con SENASA/Aduana antes de operar.
              </p>
            </section>

            <aside className="info-col">
              <ResumenConsulta resumen={ultimoMensajeConResumen?.resumen} ultimaPregunta={ultimaPreguntaUsuario?.content} />
              <NormativaRelacionada fuentes={ultimoMensajeAsistente?.fuentes} />
              <FuentesPanel />
            </aside>
          </div>

          <section className="frecuentes">
            <p className="frecuentes-titulo">Consultas frecuentes</p>
            <div className="frecuentes-grid">
              {PREGUNTAS_EJEMPLO.map((p) => (
                <button key={p} className="frecuente-card" onClick={() => enviarPregunta(p)}>
                  {p}
                </button>
              ))}
            </div>
          </section>

          <footer className="footer-bar">
            <span className="footer-bar-titulo">Fuentes consultadas</span>
            <span>SENASA</span>
            <span>Aduana/ARCA</span>
            <span className="footer-bar-derecha">
              Normativa actualizada al {ULTIMA_ACTUALIZACION_NORMATIVA}
            </span>
          </footer>
          </>
          )}
        </main>
      </div>

      {fichaAbierta && (
        <FichaNormaModal
          fuente={fichaAbierta}
          esFavorito={favoritosIds.has(idFuente(fichaAbierta))}
          onAlternarFavorito={alternarFavorito}
          onCerrar={() => setFichaAbierta(null)}
        />
      )}
    </div>
  );
}

