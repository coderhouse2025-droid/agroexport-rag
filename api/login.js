// Gate de acceso simple para la demo (26/09/2026): una única clave compartida guardada en
// la variable de entorno SITE_PASSWORD de Vercel, NO cuentas individuales por usuario.
// Objetivo: que la app no quede abierta a cualquiera que tenga la URL mientras la evalúan
// para el concurso, no proteger datos sensibles de usuarios (no hay cuentas ni datos
// personales -- Historial y Favoritos siguen siendo locales al navegador de cada uno).
//
// El chequeo real pasa acá Y en api/chat.js: si solo estuviera en el frontend, cualquiera
// podría abrir la consola del navegador, ver el código y saltarse la pantalla de login sin
// necesitar la clave -- lo único verdaderamente protegido es lo que un servidor rechaza.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Método no permitido" });
    return;
  }

  const esperado = process.env.SITE_PASSWORD;
  if (!esperado) {
    // Si nadie configuró la variable en Vercel, no queremos que la app quede totalmente
    // inaccesible por un olvido de configuración -- se deja pasar, pero se loguea el aviso
    // para que quede claro en los logs de Vercel que el gate no está activo.
    console.warn("[login] SITE_PASSWORD no está configurada: el gate de acceso está desactivado.");
    res.status(200).json({ ok: true, sinConfigurar: true });
    return;
  }

  const { clave } = req.body || {};
  if (typeof clave === "string" && clave === esperado) {
    res.status(200).json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "Clave incorrecta." });
  }
}
