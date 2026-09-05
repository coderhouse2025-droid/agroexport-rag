import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const PREGUNTAS_EJEMPLO = [
  "¿Qué necesito para exportar soja a China?",
  "¿Cuáles son los requisitos para exportar trigo a Brasil?",
  "¿Qué es el Anexo III de la convocatoria de granos a China?",
];

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

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-marca">
          <img src="/logo.png" alt="Ceres AI" className="app-header-logo-img" />
          <p className="app-header-subtitulo">
            Asistente inteligente de normativa agroexportadora
          </p>
          <div className="app-header-badge">
            <span className="app-header-badge-dot" />
            Fuentes actualizadas (SENASA / Aduana)
          </div>
        </div>
      </header>

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
    </div>
  );
}
