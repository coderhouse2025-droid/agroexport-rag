import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const PREGUNTAS_EJEMPLO = [
  "¿Qué necesito para exportar soja a China?",
  "¿Cuáles son los requisitos para exportar trigo a Brasil?",
  "¿Qué es el Anexo III de la convocatoria de granos a China?",
];

const NAV_ITEMS = [
  { id: "inicio", label: "Inicio", icono: "🏠", activo: true },
  { id: "consultas", label: "Consultas", icono: "💬", activo: false },
  { id: "historial", label: "Historial", icono: "🕘", activo: false },
  { id: "favoritos", label: "Favoritos", icono: "⭐", activo: false },
  { id: "normativa", label: "Normativa", icono: "📄", activo: false },
  { id: "descargas", label: "Descargas", icono: "⬇️", activo: false },
];

function Sidebar() {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) =>
          item.activo ? (
            <div key={item.id} className="sidebar-item sidebar-item-activo">
              <span className="sidebar-icono">{item.icono}</span>
              {item.label}
            </div>
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

function Topbar() {
  return (
    <div className="topbar">
      <div className="topbar-marca">
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
          <span className="topbar-fuente-dot topbar-fuente-dot-pendiente" />
          Aduana/ARCA
        </span>
      </div>
    </div>
  );
}

function ResumenConsulta({ ultimaPregunta }) {
  return (
    <div className="panel-info">
      <p className="panel-info-titulo">📋 Resumen de la consulta</p>
      {ultimaPregunta ? (
        <p className="panel-info-texto">{ultimaPregunta}</p>
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
        <span className="panel-info-check-pendiente">En relevamiento</span>
      </div>
    </div>
  );
}

function Sello({ fuente }) {
  const etiqueta = fuente.numeroNorma
    ? `${fuente.tipoNorma} ${fuente.organismoEmisor ?? ""} N° ${fuente.numeroNorma}`.trim()
    : fuente.titulo;

  const contenido = (
    <div className="sello">
      <span className="sello-tipo">
        {fuente.fuente === "noticia" ? "Comunicado" : "Norma"}
      </span>
      <span className="sello-texto">{etiqueta}</span>
      {fuente.anio && <span className="sello-anio">{fuente.anio}</span>}
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

export default function App() {
  const [mensajes, setMensajes] = useState([]);
  const [input, setInput] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const finRef = useRef(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes]);

  async function enviarPregunta(pregunta) {
    if (!pregunta.trim() || cargando) return;
    setError(null);

    const historial = mensajes.map((m) => ({ role: m.role, content: m.content }));
    const nuevosMensajes = [
      ...mensajes,
      { role: "user", content: pregunta.trim() },
      { role: "assistant", content: "", fuentes: [] },
    ];
    setMensajes(nuevosMensajes);
    setInput("");
    setCargando(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pregunta: pregunta.trim(), historial }),
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
            setMensajes((prev) => {
              const copia = [...prev];
              copia[copia.length - 1] = { ...copia[copia.length - 1], fuentes: evento.fuentes };
              return copia;
            });
          } else if (evento.tipo === "texto") {
            setMensajes((prev) => {
              const copia = [...prev];
              const ultimo = copia[copia.length - 1];
              copia[copia.length - 1] = { ...ultimo, content: ultimo.content + evento.contenido };
              return copia;
            });
          } else if (evento.tipo === "error") {
            setError(evento.mensaje);
          }
        }
      }
    } catch (err) {
      setError(err.message || "No se pudo generar la respuesta.");
    } finally {
      setCargando(false);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    enviarPregunta(input);
  }

  const ultimoMensajeAsistente = [...mensajes].reverse().find((m) => m.role === "assistant" && m.fuentes?.length > 0);
  const ultimaPreguntaUsuario = [...mensajes].reverse().find((m) => m.role === "user");

  return (
    <div className="app-shell">
      <Topbar />
      <div className="app-body">
        <Sidebar />

        <main className="app-main">
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
              <ResumenConsulta ultimaPregunta={ultimaPreguntaUsuario?.content} />
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
            <span>Aduana/ARCA (en relevamiento)</span>
            <span className="footer-bar-derecha">Información oficial · Actualizada constantemente</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
