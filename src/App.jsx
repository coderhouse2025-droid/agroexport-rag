
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const PREGUNTAS_EJEMPLO = [
  "¿Qué necesito para exportar soja a China?",
  "¿Cuáles son los requisitos para exportar trigo a Brasil?",
  "¿Qué es el Anexo III de la convocatoria de granos a China?",
];

const NAV_ITEMS = [
  { id: "inicio", label: "Inicio", icono: "🏠", activo: true },
  { id: "historial", label: "Historial", icono: "🕘", activo: true },
  { id: "favoritos", label: "Favoritos", icono: "⭐", activo: false },
  { id: "normativa", label: "Normativa", icono: "📄", activo: false },
  { id: "descargas", label: "Descargas", icono: "⬇️", activo: false },
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

function Sello({ fuente }) {
  const etiqueta = fuente.numeroNorma
    ? `${fuente.tipoNorma} ${fuente.organismoEmisor ?? ""} N° ${fuente.numeroNorma}`.trim()
    : fuente.titulo;

  const contenido = (
    <div className={`sello ${fuente.vigente === false ? "sello-derogada" : ""}`}>
      <span className="sello-tipo">
        {fuente.fuente === "noticia" ? "Comunicado" : "Norma"}
      </span>
      <span className="sello-texto">{etiqueta}</span>
      {fuente.anio && <span className="sello-anio">{fuente.anio}</span>}
      {fuente.vigente === false && (
        <span className="sello-derogada-badge" title={fuente.derogadaPorTitulo ? `Derogada por: ${fuente.derogadaPorTitulo}` : "Derogada"}>
          ⚠ Derogada
        </span>
      )}
    </div>
  );

  return fuente.url ? (
    <a href={fuente.url} target="_blank" rel="noreferrer" className="sello-link">
      {contenido}
    </a>
  ) : (
    contenido
  );
}

function Mensaje({ mensaje }) {
  const esUsuario = mensaje.role === "user";
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
        <div className="sellos-container">
          {mensaje.fuentes.map((f, i) => (
            <Sello key={i} fuente={f} />
          ))}
        </div>
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

function HistorialItem({ item, onAbrir, onEliminar }) {
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

export default function App() {
  const [mensajes, setMensajes] = useState([]);
  const [input, setInput] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [vista, setVista] = useState("inicio");
  const [historial, setHistorial] = useState([]);
  const finRef = useRef(null);

  useEffect(() => {
    setHistorial(cargarHistorial());
  }, []);

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
                <span className="chat-col-estado">
                  <span className="chat-col-estado-dot" />
                  En línea
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
                      <Mensaje key={i} mensaje={m} />
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
            <span className="footer-bar-derecha">Información oficial · Actualizada constantemente</span>
          </footer>
          </>
          )}
        </main>
      </div>
    </div>
  );
}

