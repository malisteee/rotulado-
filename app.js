import { db, isDemo, localDb } from "./db.js?v=14";

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */
const $app = document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const newId = () => Math.random().toString(36).slice(2, 10);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const COLORS = ["#ff9ebb", "#ffc09f", "#ffe38f", "#9ee6c0", "#9cc9ff", "#c9a7ff"];
let lastColor = COLORS[0];

// En iPad/iPhone, si la página enfoca un campo por su cuenta aparece el cursor pero
// NO el teclado, y tocar el campo después no hace nada. Por eso solo enfocamos solos
// con mouse/teclado, y si tocas un campo "enfocado a medias" lo reiniciamos.
const canAutoFocus = matchMedia("(hover: hover) and (pointer: fine)").matches;
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target;
    if (e.pointerType !== "mouse" && t.matches?.("input:not([type=range]):not([type=checkbox]), textarea") && document.activeElement === t) t.blur();
  },
  true
);
const todayStr = () => new Date().toLocaleDateString("sv"); // AAAA-MM-DD
const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const blobToDataURL = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

let toastT;
function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), ms);
}

// Comparación de respuestas: ignora tildes, mayúsculas, signos y espacios extra.
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function grade(answer, correct) {
  const a = norm(answer), c = norm(correct);
  if (!a) return "wrong";
  if (a === c) return "right";
  const tol = c.length >= 10 ? 2 : c.length >= 5 ? 1 : 0;
  return lev(a, c) <= tol ? "close" : "wrong";
}

// Estado de aprendizaje de cada rótulo
const isHard = (l) => (l.fail || 0) > 0 && (l.last === false || (l.fail || 0) > (l.ok || 0));
const isKnown = (l) => l.last === true;
// "Dudas": estructuras anotadas que todavía no sabes ubicar (se guardan junto a los rótulos)
const isTodo = (l) => l.kind === "todo";
const todosOf = (labels) => (labels || []).filter(isTodo);
const withText = (labels) => (labels || []).filter((l) => !l.kind && (l.text || "").trim());
// Apuntes libres de la imagen (también se guardan junto a los rótulos)
const notesOf = (labels) => (labels || []).find((l) => l.kind === "notes")?.text || "";
const NOTES_TEMPLATE = `Proyección:
Posición del paciente:
Rayo central:
Criterios de calidad:
Estructuras que se ven:
Otros apuntes:
`;
function deckStats(images) {
  const labels = images.flatMap((i) => withText(i.labels));
  const known = labels.filter(isKnown).length;
  return {
    imgs: images.length,
    labels: labels.length,
    known,
    today: labels.filter((l) => l.seen === todayStr()).length,
    hard: labels.filter(isHard).length,
    pct: labels.length ? Math.round((known / labels.length) * 100) : 0,
  };
}

async function compressImage(file, max = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    im.src = url;
    await im.decode();
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(im, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    return { blob, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ================================================================== */
/* Router                                                              */
/* ================================================================== */
let user = null;
let cleanup = null;
let session = null; // sesión de estudio de una carpeta completa

async function route() {
  try { await cleanup?.(); } catch {}
  cleanup = null;
  if (!user) return renderAuth();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (parts[0] === "deck" && parts[2] === "study") await startDeckStudy(parts[1], parts[3] === "hard");
    else if (parts[0] === "deck" && parts[1]) await renderDeck(parts[1]);
    else if (parts[0] === "img" && parts[1]) await renderViewer(parts[1], parts[2] || "edit");
    else if (parts[0] === "progreso") await renderProgress();
    else if (parts[0] === "dudas") await renderTodos();
    else if (parts[0] === "vocab" && parts[1] && parts[2]) await renderVocabStudy(parts[1], parts[2], parts[3] === "hard");
    else if (parts[0] === "vocab" && parts[1]) await renderVocabDeck(parts[1]);
    else if (parts[0] === "vocab") await renderVocabHome();
    else if (parts[0] === "cuenta") await renderAccount();
    else await renderHome();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="page"><div class="empty"><div class="big">⚠️</div>
      <p>${/failed to fetch|load failed|network/i.test(String(e.message || e)) ? "No se pudo conectar con el servidor. Revisa tu internet; si sigue igual, puede que el proyecto esté pausado en Supabase." : `Algo salió mal: ${esc(e.message || e)}`}</p>
      <a class="btn" href="#/">Volver al inicio</a></div></div>`;
  }
}
const go = (h) => (location.hash === h ? route() : (location.hash = h));

/* ================================================================== */
/* Inicio de sesión                                                    */
/* ================================================================== */
function renderAuth(mode = "login", msg = "", ok = false) {
  const titles = { login: "Entrar", signup: "Crear cuenta", reset: "Recuperar contraseña" };
  $app.innerHTML = `
  <div class="auth">
    <div class="logo">Rotula<span>do</span></div>
    <p class="muted">Rotula tus radiografías y estudia tapando las respuestas.</p>
    <form>
      <input class="input" type="email" name="email" placeholder="Correo" autocomplete="email" required />
      ${mode !== "reset" ? `<input class="input" type="password" name="pw" placeholder="Contraseña (mín. 6)" minlength="6"
        autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required />` : ""}
      <button class="btn primary" type="submit">${titles[mode]}</button>
      <div class="msg ${ok ? "ok" : "err"}">${esc(msg)}</div>
    </form>
    <div class="row" style="justify-content:center">
      ${mode !== "login" ? `<button class="linkbtn" data-m="login">Ya tengo cuenta</button>` : ""}
      ${mode !== "signup" ? `<button class="linkbtn" data-m="signup">Crear cuenta nueva</button>` : ""}
      ${mode === "login" ? `<button class="linkbtn" data-m="reset">Olvidé mi contraseña</button>` : ""}
    </div>
  </div>`;
  $app.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => renderAuth(b.dataset.m)));
  const form = $app.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim(), pw = form.pw?.value;
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      if (mode === "login") {
        await db.signIn(email, pw);
      } else if (mode === "signup") {
        const r = await db.signUp(email, pw);
        if (r.needsConfirm) return renderAuth("login", "Te enviamos un correo para confirmar tu cuenta. Ábrelo y luego entra aquí.", true);
      } else {
        await db.resetPassword(email);
        return renderAuth("login", "Revisa tu correo para crear una contraseña nueva.", true);
      }
    } catch (err) {
      const m = String(err.message || err);
      const nice = /invalid login/i.test(m) ? "Correo o contraseña incorrectos."
        : /not confirmed/i.test(m) ? "Primero confirma tu cuenta con el correo que te enviamos."
        : /already registered/i.test(m) ? "Ese correo ya tiene cuenta. Entra con tu contraseña."
        : /failed to fetch|load failed|network/i.test(m) ? "No se pudo conectar con el servidor. Revisa tu internet; si sigue igual, puede que el proyecto esté pausado en Supabase."
        : m;
      form.querySelector(".msg").textContent = nice;
      form.querySelector(".msg").className = "msg err";
    } finally {
      btn.disabled = false;
    }
  };
}

/* ================================================================== */
/* Inicio: carpetas                                                    */
/* ================================================================== */
function frame(decks, active, content) {
  return `<div class="shell">
  <aside class="side" id="side">
    <div class="brand">Rotula<span>do</span></div>
    <nav>
      <a href="#/" class="${active === "home" ? "on" : ""}">🏠 Inicio</a>
      <a href="#/progreso" class="${active === "progress" ? "on" : ""}">📊 Mi progreso</a>
      <a href="#/vocab" class="${active === "vocab" ? "on" : ""}">📖 Vocabulario</a>
      <a href="#/dudas" class="${active === "todos" ? "on" : ""}">📝 Dudas para clase${(() => { const n = decks.reduce((k, d) => k + d.images.reduce((j, im) => j + todosOf(im.labels).length, 0), 0); return n ? `<small>${n}</small>` : ""; })()}</a>
      <a href="#/cuenta" class="${active === "account" ? "on" : ""}">👤 Mi cuenta</a>
    </nav>
    <div class="side-h">Mis carpetas</div>
    <nav>
      ${decks.map((d) => `<a href="#/deck/${d.id}" class="${active === d.id ? "on" : ""}">📁 <span class="ell">${esc(d.name)}</span><small>${deckStats(d.images).pct}%</small></a>`).join("")}
      <button class="side-new" id="sideNew">＋ Nueva carpeta</button>
    </nav>
    <a class="side-foot" href="#/cuenta">${isDemo ? "💾 Sin cuenta (solo este dispositivo)" : `👤 ${esc(user.email)}`}</a>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">${content}</main>
</div>`;
}
const menuBtn = `<button class="icon-btn menu-btn" aria-label="Menú">☰</button>`;
function wireFrame() {
  const close = () => document.body.classList.remove("side-open");
  $app.querySelectorAll(".menu-btn").forEach((b) => (b.onclick = () => document.body.classList.add("side-open")));
  $app.querySelector("#scrim").onclick = close;
  $app.querySelectorAll(".side a").forEach((a) => a.addEventListener("click", close));
  $app.querySelector("#sideNew").onclick = () => { close(); newDeck(); };
}
async function newDeck() {
  const name = prompt("Nombre de la carpeta (ej: Codo, Hombro, Tórax AP):");
  if (!name?.trim()) return;
  const d = await db.createDeck(name.trim());
  go(`#/deck/${d.id}`);
}

async function renderHome() {
  const decks = await db.listDecks();
  let localDecks = [];
  if (!isDemo) try { localDecks = await localDb.listDecks(); } catch {}
  const t = deckStats(decks.flatMap((d) => d.images));
  $app.innerHTML = frame(decks, "home", `
  <div class="page">
    <div class="topbar">${menuBtn}<h1>Mis carpetas</h1></div>
    ${isDemo ? `<div class="banner">💾 Todavía no tienes cuenta: lo que hagas se guarda solo en este dispositivo. <a href="#/cuenta">¿Qué significa?</a></div>` : ""}
    ${localDecks.length ? `<div class="banner" id="migrate">📲 En este dispositivo tienes <b>${localDecks.length} carpeta${localDecks.length === 1 ? "" : "s"}</b> de antes de crear tu cuenta.
      <button class="btn small primary" id="doMigrate" style="margin-left:8px">Pasarlas a mi cuenta</button></div>` : ""}
    ${t.labels ? `<div class="today">
        <span class="pill">🔥 Hoy repasaste <b>${t.today}</b> rótulo${t.today === 1 ? "" : "s"}</span>
        <span class="pill">✅ <b>${t.known}</b> de ${t.labels} aprendidos</span>
        ${t.hard ? `<span class="pill">🔁 <b>${t.hard}</b> difíciles</span>` : ""}
        <a class="pill" href="#/progreso">📊 Ver mi progreso →</a>
      </div>` : ""}
    <div class="row" style="margin-bottom:16px">
      <button class="btn primary" id="new">＋ Nueva carpeta</button>
    </div>
    ${decks.length ? `<div class="grid">${decks.map((d) => {
      const s = deckStats(d.images);
      return `<button class="card" data-id="${d.id}">
        <h3>${esc(d.name)}</h3>
        <div class="stats"><span>🩻 ${s.imgs} ${s.imgs === 1 ? "imagen" : "imágenes"}</span><span>🏷️ ${s.labels} rótulos</span>
        ${s.hard ? `<span><i class="dot"></i>${s.hard} difíciles</span>` : ""}</div>
        <div class="stats"><span>${s.pct}% aprendido</span></div>
        <div class="bar"><i style="width:${s.pct}%"></i></div>
      </button>`;
    }).join("")}</div>`
    : `<div class="empty"><div class="big">📁</div><p>Crea tu primera carpeta, por ejemplo <b>Codo</b> o <b>Tórax</b>.</p></div>`}
  </div>`);
  wireFrame();
  $app.querySelector("#new").onclick = newDeck;
  $app.querySelector("#doMigrate")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      let n = 0;
      const total = localDecks.reduce((k, d) => k + d.images.length, 0);
      for (const d of localDecks) {
        const deck = await db.createDeck(d.name);
        for (const im of await localDb.listImages(d.id)) {
          e.target.textContent = `Pasando ${++n} de ${total}…`;
          const [u] = await localDb.imageUrls([im]);
          const blob = await (await fetch(u)).blob();
          const row = await db.uploadImage(deck.id, blob, im.title || "", im.width, im.height);
          await db.updateImage(row.id, { labels: im.labels || [], label_size: im.label_size || 1 });
        }
        await localDb.deleteDeck(d.id);
      }
      toast("¡Listo! Tus carpetas ya están en tu cuenta ✓");
    } catch (err) {
      console.error(err);
      toast("No se pudo terminar. Intenta de nuevo.");
    }
    route();
  });
  $app.querySelectorAll(".card").forEach((c) => (c.onclick = () => go(`#/deck/${c.dataset.id}`)));
}

/* ---------- Mi progreso ---------- */
async function renderProgress() {
  const decks = await db.listDecks();
  const all = deckStats(decks.flatMap((d) => d.images));
  const hard = decks
    .flatMap((d) => d.images.flatMap((im) => withText(im.labels).filter(isHard).map((l) => ({ l, im, d }))))
    .sort((a, b) => ((b.l.fail || 0) - (b.l.ok || 0)) - ((a.l.fail || 0) - (a.l.ok || 0)))
    .slice(0, 20);
  $app.innerHTML = frame(decks, "progress", `
  <div class="page">
    <div class="topbar">${menuBtn}<h1>Mi progreso</h1></div>
    ${all.labels ? `
    <div class="kpis">
      <div class="kpi"><b>${all.pct}%</b><span>aprendido</span></div>
      <div class="kpi"><b>${all.known}</b><span>de ${all.labels} rótulos sabidos</span></div>
      <div class="kpi"><b>${all.today}</b><span>repasados hoy</span></div>
      <div class="kpi"><b>${all.hard}</b><span>difíciles</span></div>
    </div>
    <h2 class="sec">Por carpeta</h2>
    <div class="plist">${decks.map((d) => {
      const s = deckStats(d.images);
      return `<a class="prow" href="#/deck/${d.id}">
        <span class="ell"><b>${esc(d.name)}</b><br><small class="muted">${s.known} de ${s.labels} sabidos${s.hard ? ` · ${s.hard} difíciles` : ""}</small></span>
        <span class="bar"><i style="width:${s.pct}%"></i></span><b>${s.pct}%</b></a>`;
    }).join("")}</div>
    <h2 class="sec">Los que más te cuestan</h2>
    ${hard.length ? `<div class="plist">${hard.map(({ l, im, d }) => `
      <a class="prow" href="#/img/${im.id}/quiz">
        <span class="ell"><b>${esc(l.text)}</b><br><small class="muted">${esc(d.name)} · ${esc(im.title || "Sin título")}</small></span>
        <small class="muted">✓ ${l.ok || 0} · ✗ ${l.fail || 0}</small><span class="btn small">Practicar</span></a>`).join("")}</div>`
    : `<p class="muted">¡Nada por ahora! Cuando falles un rótulo en el quiz aparecerá aquí. 🎉</p>`}
    <p class="muted" style="font-size:13px;margin-top:20px">Un rótulo cuenta como “sabido” cuando lo respondiste bien la última vez que te lo preguntaron en el Quiz.</p>`
    : `<div class="empty"><div class="big">📊</div><p>Aquí verás tu avance cuando rotules imágenes y hagas el <b>Quiz</b>.</p></div>`}
  </div>`);
  wireFrame();
}

/* ---------- Dudas para clase (todas las radiografías) ---------- */
async function renderTodos() {
  const decks = await db.listDecks();
  const groups = decks.flatMap((d) => d.images.filter((im) => todosOf(im.labels).length).map((im) => ({ d, im })));
  $app.innerHTML = frame(decks, "todos", `
  <div class="page">
    <div class="topbar">${menuBtn}<h1>Dudas para clase</h1></div>
    <p class="muted" style="margin-top:-8px">Estructuras que anotaste porque no sabías dónde estaban. Llévalas a clase y, cuando sepas la respuesta, abre la radiografía y toca la marca <b>❓</b> → <b>✓ Ya sé: rotular</b> (o <b>📍 Ubicar</b> si la anotaste sin marcar).</p>
    ${groups.length ? groups.map(({ d, im }) => `
      <div class="box">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <span><b>${esc(im.title || "Sin título")}</b> <small class="muted">· 📁 ${esc(d.name)}</small></span>
          <a class="btn small" href="#/img/${im.id}/edit">Abrir radiografía →</a>
        </div>
        ${todosOf(im.labels).map((t) => `
          <div class="todo-item">
            <span class="ell">❓ ${esc((t.text || "").trim() || "Punto marcado sin nombre")}${t.tx != null ? ` <small class="muted">· 📍 marcada en la imagen</small>` : ""}</span>
            <button class="btn small ghost" data-img="${im.id}" data-del="${t.id}">✓ Resuelta</button>
          </div>`).join("")}
      </div>`).join("")
    : `<div class="empty"><div class="big">📝</div><p>No tienes dudas anotadas. Cuando rotules y no sepas dónde está algo, tócalo en <b>📝 Dudas</b> dentro de la radiografía.</p></div>`}
  </div>`);
  wireFrame();
  $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const im = groups.find((g) => g.im.id === b.dataset.img).im;
    b.disabled = true;
    try {
      await db.updateImage(im.id, { labels: im.labels.filter((l) => l.id !== b.dataset.del) });
      route();
    } catch {
      toast("No se pudo guardar");
      b.disabled = false;
    }
  }));
}

/* ---------- Mi cuenta ---------- */
async function renderAccount() {
  const decks = await db.listDecks();
  $app.innerHTML = frame(decks, "account", `
  <div class="page">
    <div class="topbar">${menuBtn}<h1>Mi cuenta</h1></div>
    ${isDemo ? `
    <div class="box">
      <h3>🔒 Las cuentas todavía no están activadas</h3>
      <p>Por ahora la página funciona <b>sin cuenta</b>: todo lo que haces queda guardado solo en <b>este dispositivo</b>.
      Si abres el link en otro iPad o en el celular, no vas a ver tus carpetas.</p>
      <p>Para activar las cuentas falta conectar un servicio gratuito que guarda las fotos en internet (se llama <b>Supabase</b>).
      Lo hacemos juntos con Claude en unos minutos. Cuando esté listo, aquí te aparecerá <b>Crear cuenta / Entrar</b>,
      y tus amigos podrán tener cada uno la suya, sin ver lo tuyo.</p>
      <p class="muted">Mientras tanto, descarga un respaldo de vez en cuando: sirve para no perder nada y para pasar todo a tu cuenta después.</p>
    </div>` : `
    <div class="box">
      <h3>👤 ${esc(user.email)}</h3>
      <p class="muted">Tus carpetas, fotos y progreso son privados. Solo tú los ves.</p>
      <div class="row"><button class="btn" id="pw">🔑 Cambiar contraseña</button><button class="btn danger" id="logout">Cerrar sesión</button></div>
    </div>`}
    <div class="box">
      <h3>💾 Respaldo</h3>
      <p class="muted">Descarga un archivo con todas tus carpetas, fotos y rótulos. Puedes cargarlo después en otro dispositivo o en tu cuenta.</p>
      <div class="row">
        <button class="btn" id="export" ${decks.length ? "" : "disabled"}>⬇️ Descargar respaldo</button>
        <label class="btn">⬆️ Cargar respaldo<input type="file" accept=".json,application/json" hidden id="import" /></label>
        <span class="upload-progress" id="bk" style="margin:0"></span>
      </div>
    </div>
  </div>`);
  wireFrame();
  $app.querySelector("#export").onclick = () => exportBackup($app.querySelector("#bk"));
  $app.querySelector("#import").onchange = (e) => e.target.files[0] && importBackup(e.target.files[0], $app.querySelector("#bk"));
  $app.querySelector("#logout")?.addEventListener("click", () => db.signOut());
  $app.querySelector("#pw")?.addEventListener("click", async () => {
    const pw = prompt("Nueva contraseña (mín. 6 caracteres):");
    if (!pw) return;
    try { await db.updatePassword(pw); toast("Contraseña actualizada ✓"); } catch (e) { toast(e.message); }
  });
}

/* ---------- Respaldo: descargar / cargar ---------- */
async function exportBackup(status) {
  try {
    const decks = await db.listDecks();
    const out = { app: "rotulado", version: 1, date: new Date().toISOString(), decks: [] };
    const total = decks.reduce((n, d) => n + d.images.length, 0);
    let n = 0;
    for (const d of decks) {
      const imgs = await db.listImages(d.id);
      const urls = await db.imageUrls(imgs);
      const items = [];
      for (let i = 0; i < imgs.length; i++) {
        status.textContent = `Preparando ${++n} de ${total}…`;
        const blob = await (await fetch(urls[i])).blob();
        const { title, width, height, labels, label_size } = imgs[i];
        items.push({ title, width, height, labels, label_size, data: await blobToDataURL(blob) });
      }
      out.decks.push({ name: d.name, images: items });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
    a.download = `rotulado-respaldo-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    status.textContent = "";
    toast("Respaldo descargado ✓");
  } catch (e) {
    console.error(e);
    status.textContent = "";
    toast("No se pudo crear el respaldo");
  }
}
async function importBackup(file, status) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "rotulado" || !Array.isArray(data.decks)) throw new Error("formato");
    const total = data.decks.reduce((n, d) => n + d.images.length, 0);
    if (!confirm(`Se agregarán ${data.decks.length} carpeta(s) con ${total} imagen(es). ¿Continuar?`)) return;
    let n = 0;
    for (const d of data.decks) {
      const deck = await db.createDeck(d.name);
      for (const im of d.images) {
        status.textContent = `Cargando ${++n} de ${total}…`;
        const blob = await (await fetch(im.data)).blob();
        const row = await db.uploadImage(deck.id, blob, im.title || "", im.width, im.height);
        await db.updateImage(row.id, { labels: im.labels || [], label_size: im.label_size || 1 });
      }
    }
    toast("Respaldo cargado ✓");
    route();
  } catch (e) {
    console.error(e);
    status.textContent = "";
    toast("Ese archivo no es un respaldo válido");
  }
}

/* ================================================================== */
/* Carpeta                                                             */
/* ================================================================== */
async function renderDeck(deckId) {
  const [deck, images, decks] = await Promise.all([db.getDeck(deckId), db.listImages(deckId), db.listDecks()]);
  const urls = await db.imageUrls(images);
  const s = deckStats(images);
  $app.innerHTML = frame(decks, deckId, `
  <div class="page">
    <div class="topbar">
      ${menuBtn}
      <h1>${esc(deck.name)}</h1>
      <button class="icon-btn" id="rename" aria-label="Renombrar">✎</button>
      <button class="icon-btn" id="del" aria-label="Borrar carpeta">🗑</button>
    </div>
    <div class="row" style="margin-bottom:10px">
      <label class="btn primary">＋ Subir radiografías
        <input type="file" accept="image/*" multiple hidden id="file" />
      </label>
      <button class="btn" id="study" ${s.labels ? "" : "disabled"}>✍️ Quiz de toda la carpeta</button>
      <button class="btn" id="hard" ${s.hard ? "" : "disabled"}>🔁 Repasar difíciles (${s.hard})</button>
    </div>
    <div class="stats" style="margin-bottom:16px"><span>${s.labels} rótulos</span><span>${s.pct}% aprendido</span></div>
    <div class="upload-progress" id="up"></div>
    ${images.length ? `<div class="thumbs">${images.map((im, i) => {
      const ls = withText(im.labels);
      const hard = ls.filter(isHard).length;
      return `<button class="thumb" data-id="${im.id}">
        <div class="ph" style="background-image:url('${esc(urls[i])}')"></div>
        <div class="meta"><b>${esc(im.title || "Sin título")}</b>
        <small>${ls.length} rótulo${ls.length === 1 ? "" : "s"}${hard ? ` · <i class="dot"></i>${hard}` : ""}${todosOf(im.labels).length ? ` · 📝 ${todosOf(im.labels).length}` : ""}${notesOf(im.labels).trim() ? " · 🗒" : ""}</small></div>
      </button>`;
    }).join("")}</div>`
    : `<div class="empty"><div class="big">🩻</div><p>Sube tus radiografías (puedes elegir varias a la vez).</p></div>`}
  </div>`);
  wireFrame();

  $app.querySelectorAll(".thumb").forEach((t) => (t.onclick = () => go(`#/img/${t.dataset.id}/edit`)));
  $app.querySelector("#rename").onclick = async () => {
    const name = prompt("Nuevo nombre:", deck.name);
    if (!name?.trim()) return;
    await db.renameDeck(deckId, name.trim());
    route();
  };
  $app.querySelector("#del").onclick = async () => {
    if (!confirm(`¿Borrar la carpeta "${deck.name}" y sus ${images.length} imágenes? No se puede deshacer.`)) return;
    await db.deleteDeck(deckId);
    go("#/");
  };
  $app.querySelector("#study").onclick = () => go(`#/deck/${deckId}/study`);
  $app.querySelector("#hard").onclick = () => go(`#/deck/${deckId}/study/hard`);
  $app.querySelector("#file").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    const names = await askNames(files);
    if (!names) return;
    const up = $app.querySelector("#up");
    let last;
    for (let i = 0; i < files.length; i++) {
      up.textContent = `Subiendo ${i + 1} de ${files.length}…`;
      try {
        const { blob, w, h } = await compressImage(files[i]);
        last = await db.uploadImage(deckId, blob, names[i], w, h);
      } catch (err) {
        console.error(err);
        toast(`No se pudo subir ${files[i].name}`);
      }
    }
    up.textContent = "";
    if (files.length === 1 && last) go(`#/img/${last.id}/edit`);
    else route();
  };
}

// Ventana para ponerle nombre a cada radiografía antes de subirla
function askNames(files) {
  return new Promise((resolve) => {
    const urls = files.map((f) => URL.createObjectURL(f));
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `
      <form class="modal-card">
        <h3>${files.length === 1 ? "¿Cómo se llama esta radiografía?" : `Ponle nombre a tus ${files.length} radiografías`}</h3>
        <div class="name-list">${files.map((f, i) => `
          <label class="name-row">
            <img src="${urls[i]}" alt="" />
            <input class="input" name="n${i}" placeholder="Ej: Codo lateral" autocomplete="off" enterkeyhint="${i === files.length - 1 ? "done" : "next"}" />
          </label>`).join("")}</div>
        <div class="row" style="justify-content:flex-end">
          <button type="button" class="btn ghost" id="cancel">Cancelar</button>
          <button type="submit" class="btn primary">Subir</button>
        </div>
      </form>`;
    document.body.appendChild(m);
    const inputs = [...m.querySelectorAll("input")];
    inputs.forEach((inp, i) =>
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && i < inputs.length - 1) {
          e.preventDefault();
          inputs[i + 1].focus();
        }
      })
    );
    const close = (val) => {
      urls.forEach(URL.revokeObjectURL);
      m.remove();
      resolve(val);
    };
    m.querySelector("#cancel").onclick = () => close(null);
    m.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      close(inputs.map((inp, i) => inp.value.trim() || (files.length === 1 ? "Radiografía" : `Radiografía ${i + 1}`)));
    };
    if (canAutoFocus) setTimeout(() => inputs[0].focus(), 50);
  });
}

async function startDeckStudy(deckId, hardOnly) {
  const images = await db.listImages(deckId);
  let pool = images.filter((i) => withText(i.labels).length);
  if (hardOnly) pool = pool.filter((i) => withText(i.labels).some(isHard));
  if (!pool.length) {
    toast(hardOnly ? "¡No tienes rótulos difíciles! 🎉" : "Primero rotula alguna imagen.");
    return go(`#/deck/${deckId}`);
  }
  session = { deckId, ids: shuffle(pool.map((i) => i.id)), idx: 0, hardOnly, ok: 0, fail: 0 };
  location.replace(`#/img/${session.ids[0]}/quiz`);
}

/* ================================================================== */
/* Visor: editar / estudiar / quiz                                     */
/* ================================================================== */
async function renderViewer(imgId, mode) {
  const img = await db.getImage(imgId);
  const [[url], deckImgs, allDecks] = await Promise.all([
    db.imageUrls([img]),
    db.listImages(img.deck_id),
    db.listDecks(),
  ]);
  let quizType = pref.get("quizType", "write"); // write | choice
  const undoStack = []; // deshacer
  let preEdit = null;
  const allLabels = (img.labels || []).map((l) => ({ ...l }));
  const labels = allLabels.filter((l) => !l.kind);
  let notesText = notesOf(allLabels);
  let notesOpen = false;
  const todos = allLabels.filter(isTodo);
  let placing = null; // duda que estás ubicando en la imagen
  let markMode = false; // tocar la imagen marca una duda ❓ en vez de rotular
  let selMark = null; // duda marcada que estás viendo
  let todoOpen = false;
  let labelSize = img.label_size || 1;
  if (session && session.ids[session.idx] !== imgId) session = null;
  if (!["edit", "study", "quiz"].includes(mode)) mode = "edit";

  $app.innerHTML = `
  <div class="viewer">
    <div class="vbar">
      <button class="icon-btn" id="back" aria-label="Volver">←</button>
      <input class="title" id="title" value="${esc(img.title || "")}" placeholder="✎ Nombre (ej: Codo lateral)" />
      <div class="seg" id="seg">
        <button data-m="edit">Editar</button><button data-m="study">Estudiar</button><button data-m="quiz">Quiz</button>
      </div>
      <button class="btn small ${notesText.trim() ? "sky" : ""}" id="notesBtn">🗒 Apuntes</button>
      <span class="save-state" id="saveState"></span>
    </div>
    <div class="tools" id="tools"></div>
    <div class="stage" id="stage">
      <div class="canvas" id="canvas">
        <img src="${esc(url)}" alt="" draggable="false" />
        <svg id="arrows"></svg>
        <div id="lbls"></div>
      </div>
      <button class="btn small zoom-reset" id="zoomReset" hidden>Ajustar ⤢</button>
    </div>
    <div id="bottom"></div>
    <div id="todoPanel"></div>
    <div id="notesPanel"></div>
  </div>`;

  const $ = (s) => $app.querySelector(s);
  const stage = $("#stage"), canvas = $("#canvas"), svg = $("#arrows"), lbls = $("#lbls");
  const tools = $("#tools"), bottom = $("#bottom");

  let sel = null; // id del rótulo seleccionado (editar)
  const revealed = new Set(); // estudiar
  let quiz = null; // estado del quiz

  /* ---------- Guardado ---------- */
  let saveT = null;
  const setSave = (t) => { const el = $("#saveState"); if (el) el.textContent = t; };
  const scheduleSave = () => {
    setSave("Guardando…");
    clearTimeout(saveT);
    saveT = setTimeout(saveNow, 700);
  };
  async function saveNow() {
    clearTimeout(saveT);
    saveT = null;
    try {
      await db.updateImage(img.id, {
        title: titleVal.trim(),
        labels: [...labels.filter((l) => (l.text || "").trim() || l.id === sel), ...todos,
          ...(notesText.trim() ? [{ id: "notes", kind: "notes", text: notesText }] : [])],
        label_size: labelSize,
      });
      setSave("Guardado ✓");
    } catch (e) {
      console.error(e);
      setSave("Error ✗");
      toast("No se pudo guardar. Revisa tu conexión.");
    }
  }
  let titleVal = img.title || "";
  $("#title").oninput = (e) => {
    titleVal = e.target.value;
    scheduleSave();
  };

  /* ---------- Zoom y encuadre ---------- */
  let baseW = 0, baseH = 0, fs = 16;
  const view = { s: 1, tx: 0, ty: 0 };
  function fit() {
    const r = stage.getBoundingClientRect();
    const k = Math.min(r.width / img.width, r.height / img.height) * 0.97;
    baseW = img.width * k;
    baseH = img.height * k;
    canvas.style.width = baseW + "px";
    canvas.style.height = baseH + "px";
    fs = Math.max(baseW * 0.026 * labelSize, 10);
    canvas.style.fontSize = fs + "px";
    svg.setAttribute("viewBox", `0 0 ${baseW} ${baseH}`);
    Object.assign(view, { s: 1, tx: (r.width - baseW) / 2, ty: (r.height - baseH) / 2 });
    applyView();
    drawArrows();
  }
  function applyView() {
    canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
    $("#zoomReset").hidden = view.s < 1.02;
  }
  function zoomAt(clientX, clientY, s) {
    const r = stage.getBoundingClientRect();
    const cx = (clientX - r.left - view.tx) / view.s, cy = (clientY - r.top - view.ty) / view.s;
    view.s = clamp(s, 1, 8);
    view.tx = clientX - r.left - view.s * cx;
    view.ty = clientY - r.top - view.s * cy;
    applyView();
  }
  $("#zoomReset").onclick = fit;
  const toNorm = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };

  /* ---------- Dibujo de rótulos y flechas ---------- */
  function labelClass(l) {
    const c = ["lbl"];
    if (!(l.text || "").trim()) c.push("empty-text");
    if (mode === "edit" && l.id === sel) c.push("sel");
    if (mode === "study" && !revealed.has(l.id)) c.push("covered");
    if (mode === "quiz" && quiz) {
      const res = quiz.results[l.id];
      if (res) c.push(res === "wrong" ? "wrong" : "right");
      else if (quiz.order.some((o) => o.id === l.id)) c.push("covered");
      if (quiz.order[quiz.i]?.id === l.id && !quiz.answered) c.push("active");
    }
    return c.join(" ");
  }
  function renderLabels() {
    const shown = mode === "edit" ? labels : withText(labels);
    lbls.innerHTML = shown.map((l) => `
      <div class="${labelClass(l)}" data-id="${l.id}" style="left:${l.x * 100}%;top:${l.y * 100}%;--c:${l.color}">${esc((l.text || "").trim() || "escribe…")}</div>
      ${mode === "edit" && l.tx != null ? `<div class="tip" data-id="${l.id}" style="left:${l.tx * 100}%;top:${l.ty * 100}%"></div>` : ""}`).join("")
      + (mode === "edit" ? todos.filter((t) => t.tx != null).map((t) => `
      <div class="qmark ${t.id === selMark ? "sel" : ""}" data-id="${t.id}" style="left:${t.tx * 100}%;top:${t.ty * 100}%">?${(t.text || "").trim() ? `<span class="qguess">¿${esc(t.text.trim())}?</span>` : ""}</div>`).join("") : "");
    drawArrows();
  }
  /* ---------- Geometría: rótulos sin líneas cruzadas ---------- */
  const PAD = () => fs * 0.15;
  function sizeOf(l) {
    const el = lbls.querySelector(`.lbl[data-id="${l.id}"]`);
    if (el && el.offsetWidth) return { w: el.offsetWidth, h: el.offsetHeight };
    const n = Math.max((l.text || "").trim().length, 8);
    return { w: fs * (0.62 * n + 1), h: fs * 1.45 };
  }
  function rectAt(cx, cy, sz) {
    const p = PAD();
    return { x1: cx - sz.w / 2 - p, y1: cy - sz.h / 2 - p, x2: cx + sz.w / 2 + p, y2: cy + sz.h / 2 + p };
  }
  // Tramo visible de la flecha: desde el borde del rótulo hasta la punta
  function segFrom(cx, cy, sz, l) {
    if (l.tx == null) return null;
    const ex = l.tx * baseW, ey = l.ty * baseH, dx = ex - cx, dy = ey - cy;
    const w = sz.w / 2 + PAD(), h = sz.h / 2 + PAD();
    const t = Math.min(dx ? w / Math.abs(dx) : Infinity, dy ? h / Math.abs(dy) : Infinity);
    if (t >= 1 || Math.hypot(dx, dy) < 1) return null;
    return { ax: cx + dx * t, ay: cy + dy * t, bx: ex, by: ey };
  }
  const geom = (l, cx = l.x * baseW, cy = l.y * baseH) => {
    const sz = sizeOf(l);
    return { l, rect: rectAt(cx, cy, sz), seg: segFrom(cx, cy, sz, l) };
  };
  const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  function segsCross(s, t) {
    const d1 = cross(s.ax, s.ay, s.bx, s.by, t.ax, t.ay), d2 = cross(s.ax, s.ay, s.bx, s.by, t.bx, t.by);
    const d3 = cross(t.ax, t.ay, t.bx, t.by, s.ax, s.ay), d4 = cross(t.ax, t.ay, t.bx, t.by, s.bx, s.by);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  const inRect = (x, y, r) => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2;
  function segHitsRect(s, r) {
    if (inRect(s.ax, s.ay, r) || inRect(s.bx, s.by, r)) return true;
    const e = [[r.x1, r.y1, r.x2, r.y1], [r.x2, r.y1, r.x2, r.y2], [r.x2, r.y2, r.x1, r.y2], [r.x1, r.y2, r.x1, r.y1]];
    return e.some(([ax, ay, bx, by]) => segsCross(s, { ax, ay, bx, by }));
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  // Puntaje de una posición: cruces, rótulos encimados, flechas que atraviesan rótulos, etc. (menos es mejor)
  function scoreOf(g, others) {
    let sc = 0;
    const r = g.rect, m = fs * 0.2;
    if (r.x1 < m || r.y1 < m || r.x2 > baseW - m || r.y2 > baseH - m) sc += 5000;
    for (const o of others) {
      if (g.seg && o.seg && segsCross(g.seg, o.seg)) sc += 1000;
      if (g.seg && segHitsRect(g.seg, o.rect)) sc += 600;
      if (o.seg && segHitsRect(o.seg, r)) sc += 600;
      const ov = overlap(r, o.rect);
      if (ov) sc += 800 + ov / (fs * fs) * 50;
      const ol = o.l;
      if (ol.tx != null && inRect(ol.tx * baseW, ol.ty * baseH, r)) sc += 700; // tapa el punto señalado de otro
    }
    if (g.seg) sc += Math.hypot(g.seg.bx - g.seg.ax, g.seg.by - g.seg.ay) / fs; // preferir flechas cortas
    return sc;
  }
  // Busca la mejor posición para el rótulo alrededor de su punta
  function placeSmart(l) {
    if (l.tx == null || !baseW) return;
    const others = labels.filter((o) => o !== l && ((o.text || "").trim() || o.id === sel)).map((o) => geom(o));
    const ex = l.tx * baseW, ey = l.ty * baseH, sz = sizeOf(l), base = Math.min(baseW, baseH);
    let best = null;
    for (const f of [0.09, 0.13, 0.18, 0.24, 0.31, 0.4]) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const cx = ex + Math.cos(a) * (base * f + sz.w / 2 * Math.abs(Math.cos(a)));
        const cy = ey + Math.sin(a) * (base * f + sz.h / 2 * Math.abs(Math.sin(a)));
        const g = { l, rect: rectAt(cx, cy, sz), seg: segFrom(cx, cy, sz, l) };
        if (!g.seg) continue;
        const sc = scoreOf(g, others) + f * 3;
        if (!best || sc < best.sc) best = { sc, cx, cy };
      }
    }
    if (best) {
      l.x = clamp(best.cx / baseW, 0, 1);
      l.y = clamp(best.cy / baseH, 0, 1);
    }
  }
  function countProblems() {
    const gs = withText(labels).map((l) => geom(l));
    let n = 0;
    for (let i = 0; i < gs.length; i++)
      for (let j = i + 1; j < gs.length; j++) {
        const a = gs[i], b = gs[j];
        if ((a.seg && b.seg && segsCross(a.seg, b.seg)) || (a.seg && segHitsRect(a.seg, b.rect)) || (b.seg && segHitsRect(b.seg, a.rect)) || overlap(a.rect, b.rect)) n++;
      }
    return n;
  }
  // Reordena todos los rótulos (varios intentos, se queda con el mejor)
  function tidyAll() {
    const movable = withText(labels).filter((l) => l.tx != null);
    if (!movable.length) return toast("Primero agrega rótulos con flecha");
    snap();
    const save = () => labels.map((l) => [l.x, l.y]);
    let best = { n: countProblems(), pos: save() };
    for (let pass = 0; pass < 6 && best.n > 0; pass++) {
      for (const l of shuffle(movable)) placeSmart(l);
      for (const l of shuffle(movable)) placeSmart(l);
      const n = countProblems();
      if (n < best.n) best = { n, pos: save() };
    }
    labels.forEach((l, i) => ([l.x, l.y] = best.pos[i]));
    renderLabels();
    renderTools();
    scheduleSave();
    toast(best.n ? `Quedan ${best.n} cruce(s): muévelos a mano o prueba otra vez` : "¡Listo! Ninguna línea se cruza ✓");
  }

  function drawArrows() {
    if (!baseW) return;
    const shown = mode === "edit" ? labels : withText(labels);
    const sw = Math.max(fs * 0.09, 1.5), hl = fs * 0.55;
    svg.innerHTML = shown.filter((l) => l.tx != null).map((l) => {
      if (!lbls.querySelector(`.lbl[data-id="${l.id}"]`)) return "";
      const sg = geom(l).seg;
      if (!sg) return "";
      const { ax: sx, ay: sy, bx: ex, by: ey } = sg;
      const len = Math.hypot(ex - sx, ey - sy);
      const ux = (ex - sx) / len, uy = (ey - sy) / len, a = 0.45;
      const h1x = ex - hl * (ux * Math.cos(a) - uy * Math.sin(a)), h1y = ey - hl * (uy * Math.cos(a) + ux * Math.sin(a));
      const h2x = ex - hl * (ux * Math.cos(a) + uy * Math.sin(a)), h2y = ey - hl * (uy * Math.cos(a) - ux * Math.sin(a));
      const d = `M${sx},${sy} L${ex},${ey} M${h1x},${h1y} L${ex},${ey} L${h2x},${h2y}`;
      const w = l.id === sel ? sw * 1.8 : sw;
      // borde oscuro debajo para que cada línea se distinga sobre la radiografía
      return `<path d="${d}" stroke="rgba(0,0,0,.6)" stroke-width="${w * 2.4}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${d}" stroke="${l.color}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join("");
  }
  const updateLabelEl = (l) => {
    const el = lbls.querySelector(`.lbl[data-id="${l.id}"]`);
    if (el) Object.assign(el.style, { left: l.x * 100 + "%", top: l.y * 100 + "%" });
    const tip = lbls.querySelector(`.tip[data-id="${l.id}"]`);
    if (tip) Object.assign(tip.style, { left: l.tx * 100 + "%", top: l.ty * 100 + "%" });
    drawArrows();
  };

  /* ---------- Modos ---------- */
  function setMode(m) {
    if (mode === "edit" && m !== "edit") deselect();
    mode = m;
    history.replaceState(null, "", `#/img/${img.id}/${m}`);
    $("#seg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    if (m !== "edit") placing = markMode = selMark = null;
    if (m === "study") revealed.clear();
    if (m === "quiz") startQuiz();
    else quiz = null;
    renderTools();
    renderBottom();
    renderLabels();
    renderTodo();
  }
  $("#seg").onclick = (e) => {
    const m = e.target.closest("button")?.dataset.m;
    if (m && m !== mode) {
      if (m !== "edit" && !withText(labels).length) return toast("Primero agrega rótulos en Editar.");
      session = null;
      setMode(m);
    }
  };
  $("#back").onclick = () => go(`#/deck/${img.deck_id}`);

  function renderTools() {
    if (mode === "edit") {
      tools.innerHTML = `
        ${placing ? `<span class="hint placing">📍 Toca en la imagen dónde está <b>“${esc(todos.find((t) => t.id === placing)?.text)}”</b></span>
          <button class="btn small" id="cancelPlace">Cancelar</button>`
        : markMode ? `<span class="hint placing">❓ Toca donde está la estructura que quieres preguntar en clase</span>`
        : `<span class="hint">👆 Toca la estructura para poner un rótulo · arrastra el rótulo o la punta ⚪ para moverlos</span>`}
        <button class="btn small ${markMode ? "primary" : ""}" id="markBtn">❓ ${markMode ? "Marcando… (tocar para terminar)" : "Marcar duda"}</button>
        <button class="btn small ${todos.length ? "sky" : ""}" id="todoBtn">📝 Dudas${todos.length ? ` (${todos.length})` : ""}</button>
        ${(() => { const n = baseW ? countProblems() : 0; return n ? `<span class="warn">⚠️ ${n} cruce${n === 1 ? "" : "s"}</span>` : ""; })()}
        <button class="btn small" id="tidy">🪄 Ordenar rótulos</button>
        <button class="btn small" id="undo" ${undoStack.length ? "" : "disabled"}>↶ Deshacer</button>
        <label class="size">Aa <input type="range" id="size" min="0.5" max="2" step="0.1" value="${labelSize}" /></label>
        <select id="move" aria-label="Mover a carpeta">
          ${allDecks.map((d) => `<option value="${d.id}" ${d.id === img.deck_id ? "selected" : ""}>📁 ${esc(d.name)}</option>`).join("")}
        </select>
        <button class="btn small danger" id="delImg">🗑 Borrar imagen</button>`;
      tools.querySelector("#undo").onclick = undo;
      tools.querySelector("#tidy").onclick = tidyAll;
      tools.querySelector("#markBtn").onclick = () => {
        markMode = !markMode;
        placing = null;
        if (sel) deselect();
        renderTools();
      };
      tools.querySelector("#todoBtn").onclick = () => {
        todoOpen = !todoOpen;
        if (todoOpen && notesOpen) { notesOpen = false; renderNotes(); }
        renderTodo();
      };
      tools.querySelector("#cancelPlace")?.addEventListener("click", () => {
        placing = null;
        renderTools();
      });
      tools.querySelector("#move").onchange = async (e) => {
        const to = allDecks.find((d) => d.id === e.target.value);
        try {
          await db.updateImage(img.id, { deck_id: to.id });
          img.deck_id = to.id;
          toast(`Movida a “${to.name}” ✓`);
        } catch {
          toast("No se pudo mover");
          e.target.value = img.deck_id;
        }
      };
      tools.querySelector("#size").oninput = (e) => {
        labelSize = +e.target.value;
        const s = { ...view };
        fit();
        Object.assign(view, s);
        applyView();
        scheduleSave();
      };
      tools.querySelector("#delImg").onclick = async () => {
        if (!confirm("¿Borrar esta imagen y sus rótulos?")) return;
        clearTimeout(saveT);
        saveT = null;
        await db.deleteImage(img);
        go(`#/deck/${img.deck_id}`);
      };
    } else if (mode === "study") {
      const n = withText(labels).length;
      tools.innerHTML = `
        <span class="hint">Toca un rectángulo para destapar · ${revealed.size}/${n} a la vista</span>
        <button class="btn small" id="showAll">👁 Mostrar todo</button>
        <button class="btn small" id="hideAll">🙈 Tapar todo</button>`;
      tools.querySelector("#showAll").onclick = () => {
        withText(labels).forEach((l) => revealed.add(l.id));
        renderTools();
        renderLabels();
      };
      tools.querySelector("#hideAll").onclick = () => {
        revealed.clear();
        renderTools();
        renderLabels();
      };
    } else {
      const done = quiz ? Object.keys(quiz.results).length : 0;
      const total = quiz?.order.length || 0;
      const ok = quiz ? Object.values(quiz.results).filter((r) => r !== "wrong").length : 0;
      tools.innerHTML = `
        <span class="hint">${session ? `Imagen ${session.idx + 1} de ${session.ids.length} · ` : ""}Rótulo ${Math.min(done + 1, total)} de ${total}
        · ✓ ${ok} · ✗ ${done - ok}</span>
        <div class="seg" id="qtype">
          <button data-t="write" class="${quizType === "write" ? "on" : ""}">✍️ Escribir</button>
          <button data-t="choice" class="${quizType === "choice" ? "on" : ""}">🔘 Opciones</button>
        </div>
        ${session ? "" : `<button class="btn small" id="restart">↺ Reiniciar</button>`}`;
      tools.querySelector("#restart")?.addEventListener("click", () => setMode("quiz"));
      tools.querySelector("#qtype").onclick = (e) => {
        const t = e.target.closest("button")?.dataset.t;
        if (!t || t === quizType) return;
        quizType = t;
        pref.set("quizType", t);
        renderTools();
        renderBottom();
      };
    }
  }

  /* ---------- Apuntes de la imagen ---------- */
  function renderNotes() {
    const panel = $("#notesPanel");
    $("#notesBtn").classList.toggle("sky", !!notesText.trim());
    if (!notesOpen) return (panel.innerHTML = "");
    panel.innerHTML = `
      <div class="todo-panel notes-panel">
        <div class="row" style="justify-content:space-between"><b>🗒 Apuntes de esta radiografía</b>
          <button class="icon-btn" id="notesClose" aria-label="Cerrar">✕</button></div>
        <textarea class="input area notes-area" id="notesArea" placeholder="Escribe lo que quieras recordar de esta imagen: proyección, posición, criterios de calidad, lo que dijo el profe…">${esc(notesText)}</textarea>
        <div class="row" style="justify-content:space-between">
          <button class="btn small" id="notesTpl">📋 Usar plantilla</button>
          <small class="muted">Se guarda solo</small>
        </div>
      </div>`;
    const area = panel.querySelector("#notesArea");
    area.oninput = () => {
      notesText = area.value;
      $("#notesBtn").classList.toggle("sky", !!notesText.trim());
      scheduleSave();
    };
    panel.querySelector("#notesClose").onclick = () => { notesOpen = false; renderNotes(); };
    panel.querySelector("#notesTpl").onclick = () => {
      area.value = notesText.trim() ? notesText.replace(/\s*$/, "\n\n") + NOTES_TEMPLATE : NOTES_TEMPLATE;
      area.oninput();
    };
  }
  $("#notesBtn").onclick = () => {
    notesOpen = !notesOpen;
    if (notesOpen && todoOpen) { todoOpen = false; renderTodo(); }
    renderNotes();
  };

  /* ---------- Dudas para clase ---------- */
  function renderTodo() {
    const panel = $("#todoPanel");
    if (!todoOpen || mode !== "edit") return (panel.innerHTML = "");
    panel.innerHTML = `
      <div class="todo-panel">
        <div class="row" style="justify-content:space-between"><b>📝 Dudas para clase</b>
          <button class="icon-btn" id="todoClose" aria-label="Cerrar">✕</button></div>
        <p class="muted" style="margin:0;font-size:14px">Anota las estructuras que no sabes dónde están para preguntarlas en clase. Cuando lo sepas, toca <b>📍 Ubicar</b>.</p>
        <form id="todoForm" class="row" style="flex-wrap:nowrap">
          <input class="input" id="todoIn" placeholder="Ej: Apófisis coracoides" autocomplete="off" enterkeyhint="done" />
          <button class="btn primary" type="submit">Anotar</button>
        </form>
        <div class="todo-list">${todos.length ? todos.map((t) => `
          <div class="todo-item">
            <span class="ell">❓ ${t.tx != null ? `${esc((t.text || "").trim() || "Punto marcado")} <small class="muted">· marcada en la imagen</small>` : esc(t.text)}</span>
            ${t.tx != null ? `<button class="btn small mint" data-convert="${t.id}">✓ Rotular</button>` : `<button class="btn small" data-place="${t.id}">📍 Ubicar</button>`}
            <button class="btn small ghost" data-del="${t.id}" aria-label="Borrar">✕</button>
          </div>`).join("") : `<p class="muted" style="font-size:14px">No tienes dudas en esta radiografía 🎉</p>`}</div>
      </div>`;
    panel.querySelector("#todoClose").onclick = () => { todoOpen = false; renderTodo(); };
    panel.querySelector("#todoForm").onsubmit = (e) => {
      e.preventDefault();
      const v = panel.querySelector("#todoIn").value.trim();
      if (!v) return;
      todos.push({ id: newId(), kind: "todo", text: v, created: todayStr() });
      scheduleSave();
      renderTodo();
      renderTools();
    };
    panel.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
      todos.splice(todos.findIndex((t) => t.id === b.dataset.del), 1);
      scheduleSave();
      renderTodo();
      renderTools();
    }));
    panel.querySelectorAll("[data-convert]").forEach((b) => (b.onclick = () => {
      todoOpen = false;
      renderTodo();
      convertMark(todos.find((t) => t.id === b.dataset.convert));
    }));
    panel.querySelectorAll("[data-place]").forEach((b) => (b.onclick = () => {
      if (sel) deselect();
      placing = b.dataset.place;
      todoOpen = false;
      renderTodo();
      renderTools();
    }));
  }

  /* ---------- Hoja de edición del rótulo ---------- */
  function snap() {
    undoStack.push(JSON.stringify(labels));
    if (undoStack.length > 60) undoStack.shift();
    const u = tools.querySelector("#undo");
    if (u) u.disabled = false;
  }
  function undo() {
    if (!undoStack.length) return;
    labels.splice(0, labels.length, ...JSON.parse(undoStack.pop()));
    sel = null;
    preEdit = null;
    renderLabels();
    renderBottom();
    renderTools();
    scheduleSave();
  }
  function select(id, focus = true, fresh = false) {
    selMark = null;
    preEdit = fresh ? null : JSON.stringify(labels);
    sel = id;
    renderLabels();
    renderBottom(focus);
  }
  function deselect() {
    if (!sel) return;
    const l = labels.find((x) => x.id === sel);
    sel = null;
    if (l && !(l.text || "").trim()) labels.splice(labels.indexOf(l), 1);
    renderLabels();
    if (l?.auto && (l.text || "").trim()) {
      placeSmart(l); // ya sabemos el largo del texto: reubicar sin cruces
      renderLabels();
    }
    if (l) delete l.auto;
    renderBottom();
    renderTools();
    scheduleSave();
  }
  // Pasar una duda marcada a rótulo (en el mismo punto)
  function convertMark(t) {
    if (!t) return;
    const l = { id: newId(), text: (t.text || "").trim(), color: lastColor, x: t.tx, y: t.ty, tx: t.tx, ty: t.ty, ok: 0, fail: 0, auto: true };
    snap();
    placeSmart(l);
    labels.push(l);
    todos.splice(todos.indexOf(t), 1);
    selMark = null;
    markMode = false;
    renderTools();
    select(l.id, true, true);
    toast(l.text ? "Revisa el nombre y toca Listo ✓" : "Escribe el nombre de la estructura");
  }
  function renderBottom(focus) {
    const t = mode === "edit" && selMark && todos.find((x) => x.id === selMark);
    if (t) {
      bottom.innerHTML = `
        <div class="sheet">
          <b>❓ Duda marcada</b>
          <input class="input" id="markText" value="${esc(t.text || "")}" placeholder="¿Qué crees que es? (opcional)" autocomplete="off" enterkeyhint="done" />
          <div class="row">
            <button class="btn danger" id="markDel">Eliminar</button>
            <button class="btn mint" id="markLabel">✓ Ya sé: rotular</button>
            <button class="btn primary" id="markDone">Listo</button>
          </div>
        </div>`;
      const inp = bottom.querySelector("#markText");
      const closeMark = () => { selMark = null; renderLabels(); renderBottom(); renderTools(); };
      inp.oninput = () => {
        t.text = inp.value;
        const el = lbls.querySelector(`.qmark[data-id="${t.id}"]`);
        if (el) el.innerHTML = "?" + (inp.value.trim() ? `<span class="qguess">¿${esc(inp.value.trim())}?</span>` : "");
        scheduleSave();
      };
      inp.onkeydown = (e) => { if (e.key === "Enter") closeMark(); };
      bottom.querySelector("#markDone").onclick = closeMark;
      bottom.querySelector("#markDel").onclick = () => {
        todos.splice(todos.indexOf(t), 1);
        scheduleSave();
        closeMark();
      };
      bottom.querySelector("#markLabel").onclick = () => convertMark(t);
      return;
    }
    if (mode === "edit" && sel) {
      const l = labels.find((x) => x.id === sel);
      bottom.innerHTML = `
        <div class="sheet">
          <input class="input" id="lblText" value="${esc(l.text || "")}" placeholder="Nombre de la estructura (ej: Radio)"
            autocomplete="off" autocapitalize="sentences" enterkeyhint="done" />
          <input class="input" id="lblNote" value="${esc(l.note || "")}" placeholder="💡 Pista o nota (opcional)" autocomplete="off" enterkeyhint="done" />
          <div class="row">
            <div class="colors">${COLORS.map((c) => `<button class="color ${c === l.color ? "on" : ""}" style="--c:${c}" data-c="${c}" aria-label="color"></button>`).join("")}</div>
            <label class="switch"><input type="checkbox" id="arrow" ${l.tx != null ? "checked" : ""}/> Flecha</label>
          </div>
          <div class="row">
            <button class="btn danger" id="delLbl">Eliminar</button>
            <button class="btn primary" id="done">Listo</button>
          </div>
        </div>`;
      const input = bottom.querySelector("#lblText");
      const firstEdit = () => {
        if (preEdit) {
          undoStack.push(preEdit);
          preEdit = null;
          const u = tools.querySelector("#undo");
          if (u) u.disabled = false;
        }
      };
      const note = bottom.querySelector("#lblNote");
      note.oninput = () => {
        firstEdit();
        l.note = note.value;
        scheduleSave();
      };
      note.onkeydown = (e) => { if (e.key === "Enter") deselect(); };
      input.oninput = () => {
        firstEdit();
        l.text = input.value;
        const el = lbls.querySelector(`.lbl[data-id="${l.id}"]`);
        if (el) {
          el.textContent = input.value.trim() || "escribe…";
          el.classList.toggle("empty-text", !input.value.trim());
        }
        drawArrows();
        scheduleSave();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") deselect(); };
      bottom.querySelectorAll(".color").forEach((b) => (b.onclick = () => {
        snap();
        l.color = lastColor = b.dataset.c;
        renderLabels();
        renderBottom();
        scheduleSave();
      }));
      bottom.querySelector("#arrow").onchange = (e) => {
        snap();
        if (e.target.checked) {
          l.tx = clamp(l.x, 0, 1);
          l.ty = clamp(l.y + (l.y < 0.5 ? 0.12 : -0.12), 0, 1);
        } else l.tx = l.ty = null;
        renderLabels();
        scheduleSave();
      };
      bottom.querySelector("#delLbl").onclick = () => {
        if ((l.text || "").trim()) snap();
        labels.splice(labels.indexOf(l), 1);
        sel = null;
        renderLabels();
        renderBottom();
        scheduleSave();
      };
      bottom.querySelector("#done").onclick = deselect;
      if (focus && canAutoFocus) input.focus();
    } else if (mode === "quiz" && quiz) {
      renderQuizBar();
    } else bottom.innerHTML = "";
  }

  /* ---------- Quiz ---------- */
  function startQuiz() {
    let pool = withText(labels);
    if (session?.hardOnly) {
      const h = pool.filter(isHard);
      if (h.length) pool = h;
    }
    // primero los difíciles, luego el resto, cada grupo en orden aleatorio
    const order = [...shuffle(pool.filter(isHard)), ...shuffle(pool.filter((l) => !isHard(l)))];
    quiz = { order, i: 0, results: {}, answered: false, last: null, options: {} };
  }
  function renderQuizBar() {
    const cur = quiz.order[quiz.i];
    if (!cur) return renderQuizEnd();
    const hintBtn = cur.note?.trim() ? `<button class="btn small" type="button" id="hint">💡 Pista</button>` : "";
    const wireHint = () =>
      bottom.querySelector("#hint")?.addEventListener("click", (e) => {
        e.currentTarget.outerHTML = `<span class="note">💡 ${esc(cur.note)}</span>`;
      });
    if (!quiz.answered && quizType === "choice") {
      const opts = (quiz.options[cur.id] ??= buildChoices(cur));
      if (opts) {
        bottom.innerHTML = `
          <div class="quizbar">
            <div class="row"><span class="fb" style="margin-right:auto">¿Qué estructura es la que parpadea?</span>${hintBtn}</div>
            <div class="choices">${opts.map((o, i) => `<button class="btn" data-i="${i}">${esc(o)}</button>`).join("")}</div>
          </div>`;
        bottom.querySelectorAll(".choices .btn").forEach((b) => (b.onclick = () => answer(opts[+b.dataset.i], true)));
        wireHint();
        return;
      }
    }
    if (!quiz.answered) {
      bottom.innerHTML = `
        <div class="quizbar">
          <div class="row"><span class="fb" style="margin-right:auto">¿Qué estructura es la que parpadea?</span>${hintBtn}</div>
          <form id="qf">
            <input class="input" id="ans" placeholder="Escribe tu respuesta" autocomplete="off" autocorrect="off"
              autocapitalize="off" spellcheck="false" enterkeyhint="go" />
            <button class="btn primary" type="submit">Comprobar</button>
            <button class="btn" type="button" id="idk">No sé</button>
          </form>
        </div>`;
      const ans = bottom.querySelector("#ans");
      bottom.querySelector("#qf").onsubmit = (e) => {
        e.preventDefault();
        answer(ans.value);
      };
      bottom.querySelector("#idk").onclick = () => answer("");
      wireHint();
      if (canAutoFocus) ans.focus({ preventScroll: true });
    } else {
      const r = quiz.last;
      const msg = r.grade === "right" ? `✓ ¡Correcto! <b>${esc(cur.text)}</b>`
        : r.grade === "close" ? `✓ Casi perfecto, ojo con la ortografía: <b>${esc(cur.text)}</b>`
        : `✗ Era <b>${esc(cur.text)}</b>${r.answer ? ` (${r.exact ? "elegiste" : "escribiste"} “${esc(r.answer)}”)` : ""}`;
      bottom.innerHTML = `
        <div class="quizbar">
          <div class="fb ${r.grade === "wrong" ? "bad" : "ok"}">${msg}</div>
          ${cur.note?.trim() ? `<div class="note">💡 ${esc(cur.note)}</div>` : ""}
          <div class="row">
            ${r.grade === "wrong" && r.answer && !r.exact ? `<button class="btn" id="override">Lo tenía bien</button>` : ""}
            <button class="btn primary" id="next" style="margin-left:auto">Siguiente →</button>
          </div>
        </div>`;
      const next = bottom.querySelector("#next");
      next.onclick = () => {
        quiz.i++;
        quiz.answered = false;
        renderTools();
        renderBottom();
        renderLabels();
      };
      if (canAutoFocus) next.focus();
      bottom.querySelector("#override")?.addEventListener("click", () => {
        cur.fail = Math.max(0, (cur.fail || 0) - 1);
        cur.ok = (cur.ok || 0) + 1;
        cur.last = true;
        quiz.results[cur.id] = r.grade = "right";
        if (session) { session.fail--; session.ok++; }
        scheduleSave();
        renderTools();
        renderBottom();
        renderLabels();
      });
    }
  }
  // 3 distractores: otros rótulos de esta imagen y de la carpeta
  function buildChoices(cur) {
    const seen = new Set([norm(cur.text)]);
    const pool = [];
    for (const t of [...withText(labels), ...deckImgs.flatMap((i) => withText(i.labels))].map((l) => l.text.trim())) {
      const k = norm(t);
      if (!seen.has(k)) { seen.add(k); pool.push(t); }
    }
    if (!pool.length) return null;
    return shuffle([cur.text.trim(), ...shuffle(pool).slice(0, 3)]);
  }
  function answer(text, exact = false) {
    const cur = quiz.order[quiz.i];
    const g = exact ? (text === cur.text.trim() ? "right" : "wrong") : grade(text, cur.text);
    const good = g !== "wrong";
    cur.ok = (cur.ok || 0) + (good ? 1 : 0);
    cur.fail = (cur.fail || 0) + (good ? 0 : 1);
    cur.last = good;
    cur.seen = todayStr();
    if (session) good ? session.ok++ : session.fail++;
    quiz.results[cur.id] = g;
    quiz.answered = true;
    quiz.last = { grade: g, answer: text.trim(), exact };
    scheduleSave();
    renderTools();
    renderBottom();
    renderLabels();
  }
  function renderQuizEnd() {
    const vals = Object.values(quiz.results);
    const ok = vals.filter((r) => r !== "wrong").length, bad = vals.length - ok;
    const wrongIds = Object.keys(quiz.results).filter((k) => quiz.results[k] === "wrong");
    let actions;
    if (session && session.idx < session.ids.length - 1) {
      actions = `<button class="btn primary" id="nextImg">Siguiente imagen →</button>`;
    } else if (session) {
      actions = `<span class="fb">Carpeta terminada: ✓ ${session.ok} · ✗ ${session.fail}</span>
        <button class="btn primary" id="toDeck">Volver a la carpeta</button>`;
    } else {
      actions = `${bad ? `<button class="btn" id="retryWrong">Repetir errores (${bad})</button>` : ""}
        <button class="btn" id="again">↺ Otra vez</button>
        <button class="btn primary" id="toDeck">Volver a la carpeta</button>`;
    }
    bottom.innerHTML = `
      <div class="quizbar">
        <div class="fb ${bad ? "" : "ok"}">${bad ? `Terminaste esta imagen: ✓ ${ok} · ✗ ${bad}` : `¡Perfecto! ${ok} de ${ok} 🎉`}</div>
        <div class="row" style="justify-content:flex-end">${actions}</div>
      </div>`;
    bottom.querySelector("#nextImg")?.addEventListener("click", () => {
      session.idx++;
      go(`#/img/${session.ids[session.idx]}/quiz`);
    });
    bottom.querySelector("#toDeck")?.addEventListener("click", () => {
      session = null;
      go(`#/deck/${img.deck_id}`);
    });
    bottom.querySelector("#again")?.addEventListener("click", () => setMode("quiz"));
    bottom.querySelector("#retryWrong")?.addEventListener("click", () => {
      quiz = { order: shuffle(labels.filter((l) => wrongIds.includes(l.id))), i: 0, results: {}, answered: false, options: {} };
      renderTools();
      renderBottom();
      renderLabels();
    });
  }

  /* ---------- Gestos: tocar, arrastrar, pellizcar ---------- */
  const pointers = new Map();
  let g = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#zoomReset")) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      g = { type: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), s0: view.s };
      return;
    }
    if (pointers.size > 2) return;
    const tip = e.target.closest(".tip"), lb = e.target.closest(".lbl"), qm = mode === "edit" && e.target.closest(".qmark");
    const kind = qm ? "qmark" : tip ? "tip" : lb ? "lbl" : "bg";
    const id = (qm || tip || lb)?.dataset.id;
    const l = kind === "qmark" ? todos.find((x) => x.id === id) : labels.find((x) => x.id === id);
    g = { type: "tap", kind, id, x0: e.clientX, y0: e.clientY, moved: false, v0: { ...view }, l0: l ? { ...l } : null };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g) return;
    if (g.type === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (g.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0);
      return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      g.moved = true;
      if (mode === "edit" && g.kind !== "bg" && g.kind !== "qmark" && g.id) snap();
    }
    if (mode === "edit" && g.kind === "qmark") {
      const t = todos.find((x) => x.id === g.id);
      if (!t) return;
      t.tx = clamp(g.l0.tx + dx / (baseW * view.s), 0, 1);
      t.ty = clamp(g.l0.ty + dy / (baseH * view.s), 0, 1);
      const el = lbls.querySelector(`.qmark[data-id="${t.id}"]`);
      if (el) Object.assign(el.style, { left: t.tx * 100 + "%", top: t.ty * 100 + "%" });
      return;
    }
    const l = labels.find((x) => x.id === g.id);
    if (mode === "edit" && l && g.kind === "lbl") {
      l.x = clamp(g.l0.x + dx / (baseW * view.s), 0, 1);
      l.y = clamp(g.l0.y + dy / (baseH * view.s), 0, 1);
      delete l.auto;
      updateLabelEl(l);
    } else if (mode === "edit" && l && g.kind === "tip") {
      l.tx = clamp(g.l0.tx + dx / (baseW * view.s), 0, 1);
      l.ty = clamp(g.l0.ty + dy / (baseH * view.s), 0, 1);
      updateLabelEl(l);
    } else {
      view.tx = g.v0.tx + dx;
      view.ty = g.v0.ty + dy;
      applyView();
    }
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!g) return;
    if (g.type === "pinch") {
      if (pointers.size === 0) g = null;
      return;
    }
    if (e.type === "pointerup" && !g.moved) onTap(g, e);
    else if (g.moved && mode === "edit" && g.kind !== "bg") {
      scheduleSave();
      renderTools();
    }
    g = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, view.s * Math.exp(-e.deltaY * 0.002));
  }, { passive: false });

  function onTap(gg, e) {
    if (mode === "edit") {
      if (gg.kind === "qmark") {
        if (sel) deselect();
        selMark = gg.id;
        renderLabels();
        return renderBottom();
      }
      if (gg.kind !== "bg") {
        if (sel === gg.id) return;
        if (sel) deselect();
        return select(gg.id);
      }
      if (sel) return deselect();
      if (selMark) {
        selMark = null;
        renderLabels();
        renderTools();
        return renderBottom();
      }
      const p = toNorm(e.clientX, e.clientY);
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      if (markMode) {
        const t = { id: newId(), kind: "todo", text: "", tx: p.x, ty: p.y, created: todayStr() };
        todos.push(t);
        selMark = t.id;
        scheduleSave();
        renderLabels();
        renderTools();
        return renderBottom();
      }
      const todo = placing && todos.find((t) => t.id === placing);
      const l = {
        id: newId(), text: todo ? todo.text : "", color: lastColor,
        x: clamp(p.x + 0.06, 0.08, 0.92), y: clamp(p.y + (p.y > 0.2 ? -0.14 : 0.14), 0.05, 0.95),
        tx: p.x, ty: p.y, ok: 0, fail: 0, auto: true,
      };
      snap();
      placeSmart(l);
      labels.push(l);
      if (todo) {
        todos.splice(todos.indexOf(todo), 1);
        placing = null;
        renderTools();
        toast(`¡Ubicado “${todo.text}”! ✓`);
      }
      select(l.id, !todo, true);
    } else if (mode === "study" && gg.kind === "lbl") {
      if (revealed.has(gg.id)) revealed.delete(gg.id);
      else {
        revealed.add(gg.id);
        const note = labels.find((x) => x.id === gg.id)?.note?.trim();
        if (note) toast(`💡 ${note}`, 3500);
      }
      renderTools();
      renderLabels();
    }
  }

  /* ---------- Arranque ---------- */
  const onResize = () => fit();
  addEventListener("resize", onResize);
  const imEl = canvas.querySelector("img");
  if (!imEl.complete) await new Promise((r) => { imEl.onload = r; imEl.onerror = r; });
  setMode(mode);
  fit();
  if (mode === "edit") renderTools();
  if (document.fonts?.ready) document.fonts.ready.then(drawArrows);

  cleanup = async () => {
    removeEventListener("resize", onResize);
    if (saveT) await saveNow();
  };
}

/* ================================================================== */
/* Vocabulario                                                         */
/* ================================================================== */
const VOCAB_PROMPT = `Te adjunto una presentación (PPT) de mi clase. Necesito aprender su vocabulario técnico.

Extrae TODOS los términos técnicos que aparecen (estructuras anatómicas, términos radiológicos, proyecciones, posiciones, planos, signos, etc.) y escribe para cada uno una definición breve basada en lo que dice la presentación. Si la presentación no define un término, escribe tú una definición corta y correcta y agrega (*) al final.

Responde SOLO con un bloque de código, sin nada antes ni después, con este formato exacto:

# Tema: <título o tema de la presentación>
Término :: Definición breve
Término :: Definición breve

Reglas:
- Una línea por término, usando "::" como separador (solo una vez por línea).
- Definiciones de máximo 25 palabras, en español.
- Sin viñetas, sin números, sin negritas.
- No repitas términos y respeta las tildes.
- Si la presentación tiene varios temas claramente distintos, usa una línea "# Tema: ..." para cada uno.`;

function parseVocab(text) {
  const groups = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const h = line.match(/^#+\s*(?:tema\s*:\s*)?(.+)$/i);
    if (h) {
      cur = { topic: h[1].replace(/\*+/g, "").trim(), cards: [] };
      groups.push(cur);
      continue;
    }
    line = line.replace(/^([-*•·]|\d+[.)])\s+/, "").replace(/\*\*/g, "");
    const i = line.indexOf("::");
    if (i < 1) continue;
    const term = line.slice(0, i).trim(), def = line.slice(i + 2).trim();
    if (!term || !def) continue;
    if (!cur) groups.push((cur = { topic: "", cards: [] }));
    cur.cards.push({ term, def });
  }
  return groups.filter((g) => g.cards.length);
}
function mergeCards(existing, incoming) {
  const seen = new Set(existing.map((c) => norm(c.term)));
  let added = 0;
  for (const c of incoming) {
    const k = norm(c.term);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    existing.push({ id: newId(), term: c.term, def: c.def, ok: 0, fail: 0 });
    added++;
  }
  return added;
}
function cardStats(cards) {
  const cs = cards || [];
  const known = cs.filter(isKnown).length;
  return {
    n: cs.length, known,
    hard: cs.filter(isHard).length,
    today: cs.filter((c) => c.seen === todayStr()).length,
    pct: cs.length ? Math.round((known / cs.length) * 100) : 0,
  };
}
const vocabMissing = (e) => /vocab_decks|relation|schema cache|does not exist|not find the table/i.test(String(e?.message || e));
const VOCAB_SQL = `create table if not exists public.vocab_decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  cards jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.vocab_decks enable row level security;
drop policy if exists "vocab: solo el dueño" on public.vocab_decks;
create policy "vocab: solo el dueño" on public.vocab_decks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());`;

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    // Si el navegador no deja copiar, mostramos el texto para copiarlo a mano
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-card"><h3>Copia este texto</h3>
      <textarea class="input area" rows="12" readonly>${esc(text)}</textarea>
      <div class="row" style="justify-content:flex-end"><button class="btn primary">Cerrar</button></div></div>`;
    document.body.appendChild(m);
    const ta = m.querySelector("textarea");
    ta.focus();
    ta.select();
    m.querySelector("button").onclick = () => m.remove();
  }
}
const copyPrompt = () => copyText(VOCAB_PROMPT, "Prompt copiado ✓ Pégalo en ChatGPT junto con tu PPT");

// Ventana genérica con campos de texto
function formModal(title, fields, okLabel = "Guardar") {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<form class="modal-card"><h3>${title}</h3>
      <div class="name-list">${fields.map((f) => `<label class="flabel">${esc(f.label)}
        ${f.area ? `<textarea class="input area" name="${f.name}" rows="4">${esc(f.value || "")}</textarea>`
          : `<input class="input" name="${f.name}" value="${esc(f.value || "")}" autocomplete="off" />`}</label>`).join("")}</div>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn ghost" id="cancel">Cancelar</button>
        <button type="submit" class="btn primary">${okLabel}</button></div></form>`;
    document.body.appendChild(m);
    const close = (v) => { m.remove(); resolve(v); };
    m.querySelector("#cancel").onclick = () => close(null);
    m.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      close(Object.fromEntries(fields.map((f) => [f.name, e.target[f.name].value.trim()])));
    };
    if (canAutoFocus) m.querySelector("input,textarea")?.focus();
  });
}

// Importar: pegar lo que respondió ChatGPT
function openImport(target, allVocab) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<form class="modal-card">
    <h3>📥 Importar vocabulario${target ? ` a “${esc(target.name)}”` : ""}</h3>
    <p class="muted" style="margin:0">Pega aquí la respuesta de ChatGPT (lo que está dentro del recuadro).</p>
    <textarea class="input area" rows="10" placeholder="# Tema: Densidades radiológicas&#10;Radiolúcido :: Zona que deja pasar los rayos X y se ve oscura"></textarea>
    <div class="muted" id="prev" style="font-size:14px">Todavía no pegaste nada.</div>
    <div class="row" style="justify-content:flex-end">
      <button type="button" class="btn ghost" id="cancel">Cancelar</button>
      <button type="submit" class="btn primary" disabled>Importar</button></div></form>`;
  document.body.appendChild(m);
  const ta = m.querySelector("textarea"), prev = m.querySelector("#prev"), ok = m.querySelector("[type=submit]");
  let groups = [];
  ta.oninput = () => {
    groups = parseVocab(ta.value);
    const n = groups.reduce((k, g) => k + g.cards.length, 0);
    ok.disabled = !n;
    prev.innerHTML = !ta.value.trim() ? "Todavía no pegaste nada."
      : !n ? `⚠️ No encontré términos. Cada línea debe verse así: <b>Término :: Definición</b>`
      : `✓ Encontré <b>${n}</b> término${n === 1 ? "" : "s"}${target ? "" : groups.map((g) => `<br>• ${esc(g.topic || "Sin tema")}: ${g.cards.length}`).join("")}`;
  };
  m.querySelector("#cancel").onclick = () => m.remove();
  m.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    ok.disabled = true;
    ok.textContent = "Importando…";
    try {
      let added = 0, openId = target?.id;
      if (target) {
        const fresh = await db.getVocab(target.id);
        added = mergeCards(fresh.cards, groups.flatMap((g) => g.cards));
        await db.updateVocab(target.id, { cards: fresh.cards });
      } else {
        for (const g of groups) {
          const name = g.topic || prompt("¿Cómo se llama este tema?", "Vocabulario") || "Vocabulario";
          const same = allVocab.find((v) => norm(v.name) === norm(name));
          if (same) {
            added += mergeCards(same.cards, g.cards);
            await db.updateVocab(same.id, { cards: same.cards });
            openId = same.id;
          } else {
            const cards = [];
            added += mergeCards(cards, g.cards);
            const v = await db.createVocab(name, cards);
            allVocab.push(v);
            openId = v.id;
          }
        }
      }
      m.remove();
      toast(`✓ ${added} término${added === 1 ? "" : "s"} nuevo${added === 1 ? "" : "s"}`);
      if (!target && groups.length === 1 && openId) go(`#/vocab/${openId}`);
      else route();
    } catch (err) {
      console.error(err);
      toast("No se pudo importar. Revisa tu conexión.");
      ok.disabled = false;
      ok.textContent = "Importar";
    }
  };
  setTimeout(() => canAutoFocus && ta.focus(), 50);
}

async function renderVocabHome() {
  const decks = await db.listDecks();
  let vs = [], missing = false;
  try { vs = await db.listVocab(); } catch (e) { if (vocabMissing(e)) missing = true; else throw e; }
  const tot = cardStats(vs.flatMap((v) => v.cards));
  $app.innerHTML = frame(decks, "vocab", `
  <div class="page">
    <div class="topbar">${menuBtn}<h1>Vocabulario</h1></div>
    ${missing ? `
    <div class="box">
      <h3>🔧 Falta un paso para activar el vocabulario</h3>
      <p>Hay que crear un espacio nuevo en Supabase, igual que hiciste la primera vez:</p>
      <p>1. En Supabase abre <b>SQL Editor</b> → <b>New query</b>.<br>2. Pega este texto y toca <b>Run</b> (si sale un aviso rojo, toca <b>Run</b> otra vez).<br>3. Vuelve aquí y recarga la página.</p>
      <pre class="code">${esc(VOCAB_SQL)}</pre>
      <button class="btn primary" id="copySql">📋 Copiar texto</button>
    </div>` : `
    <div class="row" style="margin-bottom:16px">
      <button class="btn primary" id="imp">📥 Importar vocabulario</button>
      <button class="btn" id="prompt">📋 Copiar prompt para ChatGPT</button>
      <button class="btn" id="newV">＋ Mazo vacío</button>
    </div>
    ${tot.n ? `<div class="today">
      <span class="pill">📖 <b>${tot.n}</b> términos</span>
      <span class="pill">✅ <b>${tot.known}</b> aprendidos</span>
      <span class="pill">🔥 Hoy repasaste <b>${tot.today}</b></span>
      ${tot.hard ? `<span class="pill">🔁 <b>${tot.hard}</b> difíciles</span>` : ""}</div>` : ""}
    ${vs.length ? `<div class="grid">${vs.map((v) => {
      const c = cardStats(v.cards);
      return `<button class="card" data-id="${v.id}"><h3>${esc(v.name)}</h3>
        <div class="stats"><span>📖 ${c.n} términos</span>${c.hard ? `<span><i class="dot"></i>${c.hard} difíciles</span>` : ""}</div>
        <div class="stats"><span>${c.pct}% aprendido</span></div><div class="bar"><i style="width:${c.pct}%"></i></div></button>`;
    }).join("")}</div>` : `
    <div class="box how">
      <h3>¿Cómo paso el vocabulario de un PPT?</h3>
      <ol>
        <li>Toca <b>📋 Copiar prompt para ChatGPT</b>.</li>
        <li>En ChatGPT, adjunta tu PPT, pega el prompt y envíalo.</li>
        <li>Copia lo que te responda (el recuadro con “Término :: Definición”).</li>
        <li>Vuelve aquí, toca <b>📥 Importar vocabulario</b> y pégalo. ¡Listo! Se crea un mazo con todas las tarjetas.</li>
      </ol>
      <p class="muted">Puedes repetirlo con cada PPT nuevo. Si un tema ya existe, los términos nuevos se suman al mismo mazo sin repetirse.</p>
    </div>`}`}
  </div>`);
  wireFrame();
  $app.querySelector("#copySql")?.addEventListener("click", () => copyText(VOCAB_SQL, "Texto copiado ✓ Pégalo en el SQL Editor de Supabase"));
  $app.querySelector("#imp")?.addEventListener("click", () => openImport(null, vs));
  $app.querySelector("#prompt")?.addEventListener("click", copyPrompt);
  $app.querySelector("#newV")?.addEventListener("click", async () => {
    const name = prompt("Nombre del mazo (ej: Densidades radiológicas):");
    if (!name?.trim()) return;
    const v = await db.createVocab(name.trim(), []);
    go(`#/vocab/${v.id}`);
  });
  $app.querySelectorAll(".card").forEach((c) => (c.onclick = () => go(`#/vocab/${c.dataset.id}`)));
}

async function renderVocabDeck(id) {
  const [decks, v] = await Promise.all([db.listDecks(), db.getVocab(id)]);
  const c = cardStats(v.cards);
  const row = (x) => `
    <div class="vrow" data-id="${x.id}">
      <div class="vtxt"><b>${esc(x.term)}</b><span>${esc(x.def)}</span></div>
      <small class="muted">${isHard(x) ? `<i class="dot"></i>` : isKnown(x) ? "✅" : ""}</small>
      <button class="icon-btn sm" data-edit="${x.id}" aria-label="Editar">✎</button>
      <button class="icon-btn sm" data-del="${x.id}" aria-label="Borrar">✕</button>
    </div>`;
  $app.innerHTML = frame(decks, "vocab", `
  <div class="page">
    <div class="topbar">${menuBtn}<a class="icon-btn" href="#/vocab" aria-label="Volver">←</a><h1>${esc(v.name)}</h1>
      <button class="icon-btn" id="ren" aria-label="Renombrar">✎</button>
      <button class="icon-btn" id="delV" aria-label="Borrar mazo">🗑</button></div>
    <div class="row" style="margin-bottom:10px">
      <a class="btn primary ${c.n ? "" : "off"}" href="#/vocab/${id}/cards">🃏 Tarjetas</a>
      <a class="btn mint ${c.n ? "" : "off"}" href="#/vocab/${id}/quiz">✍️ Quiz</a>
      <a class="btn ${c.hard ? "" : "off"}" href="#/vocab/${id}/quiz/hard">🔁 Difíciles (${c.hard})</a>
    </div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn small" id="imp">📥 Importar aquí</button>
      <button class="btn small" id="add">＋ Agregar término</button>
      <button class="btn small" id="prompt">📋 Copiar prompt</button>
    </div>
    <div class="stats" style="margin-bottom:12px"><span>${c.n} términos</span><span>${c.pct}% aprendido</span></div>
    ${c.n > 6 ? `<input class="input" id="q" placeholder="🔎 Buscar término…" style="margin-bottom:12px" />` : ""}
    <div class="vlist" id="vlist">${c.n ? v.cards.map(row).join("") : `<div class="empty"><div class="big">📖</div><p>Este mazo está vacío. Importa el vocabulario de un PPT o agrega términos a mano.</p></div>`}</div>
  </div>`);
  wireFrame();
  const save = () => db.updateVocab(id, { cards: v.cards });
  $app.querySelector("#imp").onclick = () => openImport(v);
  $app.querySelector("#prompt").onclick = copyPrompt;
  $app.querySelector("#add").onclick = async () => {
    const r = await formModal("＋ Agregar término", [{ name: "term", label: "Término" }, { name: "def", label: "Definición", area: true }]);
    if (!r?.term || !r?.def) return;
    if (!mergeCards(v.cards, [r])) return toast("Ese término ya está en el mazo");
    await save();
    route();
  };
  $app.querySelector("#ren").onclick = async () => {
    const name = prompt("Nuevo nombre:", v.name);
    if (!name?.trim()) return;
    await db.updateVocab(id, { name: name.trim() });
    route();
  };
  $app.querySelector("#delV").onclick = async () => {
    if (!confirm(`¿Borrar el mazo "${v.name}" con sus ${c.n} términos?`)) return;
    await db.deleteVocab(id);
    go("#/vocab");
  };
  $app.querySelector("#q")?.addEventListener("input", (e) => {
    const q = norm(e.target.value);
    $app.querySelectorAll(".vrow").forEach((r) => {
      const x = v.cards.find((k) => k.id === r.dataset.id);
      r.hidden = q && !norm(x.term + " " + x.def).includes(q);
    });
  });
  $app.querySelector("#vlist").onclick = async (e) => {
    const ed = e.target.closest("[data-edit]"), dl = e.target.closest("[data-del]");
    if (ed) {
      const x = v.cards.find((k) => k.id === ed.dataset.edit);
      const r = await formModal("✎ Editar término", [{ name: "term", label: "Término", value: x.term }, { name: "def", label: "Definición", value: x.def, area: true }]);
      if (!r?.term || !r?.def) return;
      Object.assign(x, r);
      await save();
      route();
    } else if (dl) {
      const x = v.cards.find((k) => k.id === dl.dataset.del);
      if (!confirm(`¿Borrar "${x.term}"?`)) return;
      v.cards.splice(v.cards.indexOf(x), 1);
      await save();
      route();
    }
  };
}

async function renderVocabStudy(id, kind, hardOnly) {
  const v = await db.getVocab(id);
  let pool = v.cards.filter((c) => c.term && c.def);
  if (hardOnly) pool = pool.filter(isHard);
  if (!pool.length) {
    toast(hardOnly ? "¡No tienes términos difíciles! 🎉" : "El mazo está vacío");
    return go(`#/vocab/${id}`);
  }
  let dir = pref.get("vocabDir", "term"); // qué lado se ve primero en tarjetas
  let quizType = pref.get("quizType", "write");
  const makeOrder = (list) => [...shuffle(list.filter(isHard)), ...shuffle(list.filter((c) => !isHard(c)))];
  let st = { order: makeOrder(pool), i: 0, res: {}, answered: false, flipped: false, last: null, opts: {} };

  let saveT = null;
  const saveNow = async () => {
    clearTimeout(saveT);
    saveT = null;
    try { await db.updateVocab(id, { cards: v.cards }); } catch { toast("No se pudo guardar el progreso"); }
  };
  const record = (c, good) => {
    c.ok = (c.ok || 0) + (good ? 1 : 0);
    c.fail = (c.fail || 0) + (good ? 0 : 1);
    c.last = good;
    c.seen = todayStr();
    clearTimeout(saveT);
    saveT = setTimeout(saveNow, 800);
  };
  cleanup = async () => { if (saveT) await saveNow(); };

  const choicesFor = (c) => {
    const others = shuffle(v.cards.filter((o) => norm(o.term) !== norm(c.term))).slice(0, 3).map((o) => o.term);
    return others.length ? shuffle([c.term, ...others]) : null;
  };

  function render() {
    const c = st.order[st.i];
    const done = Object.keys(st.res).length, good = Object.values(st.res).filter((r) => r !== "wrong").length;
    const head = `
      <div class="vbar">
        <a class="icon-btn" href="#/vocab/${id}" aria-label="Volver">←</a>
        <b class="ell" style="flex:1">${esc(v.name)} · ${kind === "cards" ? "Tarjetas" : "Quiz"}${hardOnly ? " (difíciles)" : ""}</b>
        ${kind === "cards"
          ? `<div class="seg" id="dir"><button data-d="term" class="${dir === "term" ? "on" : ""}">Término</button><button data-d="def" class="${dir === "def" ? "on" : ""}">Definición</button></div>`
          : `<div class="seg" id="qt"><button data-t="write" class="${quizType === "write" ? "on" : ""}">✍️ Escribir</button><button data-t="choice" class="${quizType === "choice" ? "on" : ""}">🔘 Opciones</button></div>`}
      </div>
      <div class="vprog"><span>${Math.min(st.i + 1, st.order.length)} / ${st.order.length}</span><span>✓ ${good} · ✗ ${done - good}</span></div>`;
    let body;
    if (!c) {
      const wrong = st.order.filter((x) => st.res[x.id] === "wrong");
      body = `<div class="vend">
        <div class="big">${wrong.length ? "💪" : "🎉"}</div>
        <h2>${wrong.length ? `Terminaste: ✓ ${good} · ✗ ${wrong.length}` : `¡Perfecto! ${good} de ${good}`}</h2>
        <div class="row" style="justify-content:center">
          ${wrong.length ? `<button class="btn primary" id="retry">Repetir los ${wrong.length} que fallé</button>` : ""}
          <button class="btn" id="again">↺ Otra vez</button>
          <a class="btn" href="#/vocab/${id}">Volver al mazo</a></div></div>`;
    } else if (kind === "cards") {
      const front = dir === "term" ? `<div class="vterm">${esc(c.term)}</div>` : `<div class="vdef">${esc(c.def)}</div>`;
      const back = dir === "term" ? `<div class="vdef">${esc(c.def)}</div>` : `<div class="vterm">${esc(c.term)}</div>`;
      body = `
        <button class="flash ${st.flipped ? "flipped" : ""}" id="flash">
          ${front}${st.flipped ? `<hr>${back}` : `<small class="muted">Toca para dar vuelta</small>`}
        </button>
        <div class="row vbtns">${st.flipped
          ? `<button class="btn big-btn bad" id="no">✗ No lo sabía</button><button class="btn big-btn good" id="yes">✓ Lo sabía</button>`
          : `<button class="btn big-btn" id="flip">Dar vuelta</button>`}</div>`;
    } else {
      const opts = quizType === "choice" ? (st.opts[c.id] ??= choicesFor(c)) : null;
      const r = st.last;
      body = `
        <div class="flash static"><small class="muted">¿Qué término es?</small><div class="vdef">${esc(c.def)}</div></div>
        ${st.answered ? `
          <div class="fb ${r.g === "wrong" ? "bad" : "ok"} vfb">${r.g === "right" ? `✓ ¡Correcto! <b>${esc(c.term)}</b>`
            : r.g === "close" ? `✓ Casi, ojo con la ortografía: <b>${esc(c.term)}</b>`
            : `✗ Era <b>${esc(c.term)}</b>${r.a ? ` (${r.exact ? "elegiste" : "escribiste"} “${esc(r.a)}”)` : ""}`}</div>
          <div class="row vbtns">${r.g === "wrong" && r.a && !r.exact ? `<button class="btn" id="override">Lo tenía bien</button>` : ""}
            <button class="btn primary big-btn" id="next">Siguiente →</button></div>`
        : opts ? `<div class="choices">${opts.map((o, k) => `<button class="btn" data-k="${k}">${esc(o)}</button>`).join("")}</div>`
        : `<form id="qf" class="row vform"><input class="input" id="ans" placeholder="Escribe el término" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
            <button class="btn primary" type="submit">Comprobar</button><button class="btn" type="button" id="idk">No sé</button></form>`}`;
    }
    $app.innerHTML = `<div class="vstudy">${head}<div class="vbody">${body}</div></div>`;
    wire(c);
  }
  function next() {
    st.i++;
    st.answered = st.flipped = false;
    render();
  }
  function wire(c) {
    const q = (sel) => $app.querySelector(sel);
    q("#dir")?.addEventListener("click", (e) => {
      const d = e.target.closest("button")?.dataset.d;
      if (d && d !== dir) { dir = d; pref.set("vocabDir", d); st.flipped = false; render(); }
    });
    q("#qt")?.addEventListener("click", (e) => {
      const t = e.target.closest("button")?.dataset.t;
      if (t && t !== quizType) { quizType = t; pref.set("quizType", t); render(); }
    });
    q("#retry")?.addEventListener("click", () => {
      st = { order: shuffle(st.order.filter((x) => st.res[x.id] === "wrong")), i: 0, res: {}, answered: false, flipped: false, opts: {} };
      render();
    });
    q("#again")?.addEventListener("click", () => {
      st = { order: makeOrder(pool), i: 0, res: {}, answered: false, flipped: false, opts: {} };
      render();
    });
    if (!c) return;
    const flip = () => { st.flipped = true; render(); };
    q("#flash")?.addEventListener("click", () => !st.flipped && flip());
    q("#flip")?.addEventListener("click", flip);
    q("#yes")?.addEventListener("click", () => { record(c, true); st.res[c.id] = "right"; next(); });
    q("#no")?.addEventListener("click", () => { record(c, false); st.res[c.id] = "wrong"; next(); });
    const answer = (text, exact) => {
      const g = exact ? (text === c.term ? "right" : "wrong") : grade(text, c.term);
      record(c, g !== "wrong");
      st.res[c.id] = g;
      st.answered = true;
      st.last = { g, a: text.trim(), exact };
      render();
    };
    q("#qf")?.addEventListener("submit", (e) => { e.preventDefault(); answer(q("#ans").value); });
    q("#idk")?.addEventListener("click", () => answer(""));
    $app.querySelectorAll(".choices [data-k]").forEach((b) => (b.onclick = () => answer(st.opts[c.id][+b.dataset.k], true)));
    q("#next")?.addEventListener("click", next);
    q("#override")?.addEventListener("click", () => {
      c.fail = Math.max(0, (c.fail || 0) - 1);
      record(c, true);
      st.res[c.id] = st.last.g = "right";
      render();
    });
    if (canAutoFocus) (q("#ans") || q("#next"))?.focus();
  }
  render();
}

/* ================================================================== */
/* Arranque                                                            */
/* ================================================================== */
(async () => {
  try {
    await db.init();
    user = await db.getUser();
    db.onAuthChange((u, event) => {
      const changed = u?.id !== user?.id;
      user = u;
      if (event === "PASSWORD_RECOVERY") {
        const pw = prompt("Escribe tu nueva contraseña (mín. 6 caracteres):");
        if (pw) db.updatePassword(pw).then(() => toast("Contraseña actualizada ✓"), (e) => toast(e.message));
      }
      if (changed) route();
    });
    addEventListener("hashchange", route);
    route();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="page"><div class="empty"><div class="big">⚠️</div><p>No se pudo iniciar: ${esc(e.message)}</p></div></div>`;
  }
})();
