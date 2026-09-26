import { db, isDemo } from "./db.js";

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
const withText = (labels) => (labels || []).filter((l) => (l.text || "").trim());
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
    else await renderHome();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="page"><div class="empty"><div class="big">⚠️</div>
      <p>Algo salió mal: ${esc(e.message || e)}</p>
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
async function renderHome() {
  const decks = await db.listDecks();
  $app.innerHTML = `
  <div class="page">
    <div class="topbar">
      <h1>Mis carpetas</h1>
      ${isDemo ? "" : `<span class="muted" style="font-size:13px">${esc(user.email)}</span>
      <button class="btn small ghost" id="logout">Salir</button>`}
    </div>
    ${isDemo ? `<div class="banner">💾 Por ahora tus radiografías se guardan solo en este dispositivo. Cuando activemos las cuentas podrás verlas desde cualquier lado (y traspasarlas con “Descargar respaldo”).</div>` : ""}
    ${(() => {
      const t = deckStats(decks.flatMap((d) => d.images));
      return t.labels ? `<div class="today">
        <span class="pill">🔥 Hoy repasaste <b>${t.today}</b> rótulo${t.today === 1 ? "" : "s"}</span>
        <span class="pill">✅ <b>${t.known}</b> de ${t.labels} aprendidos</span>
        ${t.hard ? `<span class="pill">🔁 <b>${t.hard}</b> difíciles</span>` : ""}
      </div>` : "";
    })()}
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
    <div class="row" style="margin-top:28px">
      <button class="btn small" id="export" ${decks.length ? "" : "disabled"}>⬇️ Descargar respaldo</button>
      <label class="btn small">⬆️ Cargar respaldo<input type="file" accept=".json,application/json" hidden id="import" /></label>
      <span class="upload-progress" id="bk" style="margin:0"></span>
    </div>
  </div>`;
  $app.querySelector("#export").onclick = () => exportBackup($app.querySelector("#bk"));
  $app.querySelector("#import").onchange = (e) => e.target.files[0] && importBackup(e.target.files[0], $app.querySelector("#bk"));
  $app.querySelector("#new").onclick = async () => {
    const name = prompt("Nombre de la carpeta (ej: Codo, Hombro, Tórax AP):");
    if (!name?.trim()) return;
    const d = await db.createDeck(name.trim());
    go(`#/deck/${d.id}`);
  };
  $app.querySelector("#logout")?.addEventListener("click", () => db.signOut());
  $app.querySelectorAll(".card").forEach((c) => (c.onclick = () => go(`#/deck/${c.dataset.id}`)));
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
  const [deck, images] = await Promise.all([db.getDeck(deckId), db.listImages(deckId)]);
  const urls = await db.imageUrls(images);
  const s = deckStats(images);
  $app.innerHTML = `
  <div class="page">
    <div class="topbar">
      <a class="icon-btn" href="#/" aria-label="Volver">←</a>
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
        <small>${ls.length} rótulo${ls.length === 1 ? "" : "s"}${hard ? ` · <i class="dot"></i>${hard}` : ""}</small></div>
      </button>`;
    }).join("")}</div>`
    : `<div class="empty"><div class="big">🩻</div><p>Sube tus radiografías (puedes elegir varias a la vez).</p></div>`}
  </div>`;

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
    if (!files.length) return;
    const up = $app.querySelector("#up");
    let last;
    for (let i = 0; i < files.length; i++) {
      up.textContent = `Subiendo ${i + 1} de ${files.length}…`;
      try {
        const { blob, w, h } = await compressImage(files[i]);
        last = await db.uploadImage(deckId, blob, files[i].name.replace(/\.[^.]+$/, ""), w, h);
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
  const labels = (img.labels || []).map((l) => ({ ...l }));
  let labelSize = img.label_size || 1;
  if (session && session.ids[session.idx] !== imgId) session = null;
  if (!["edit", "study", "quiz"].includes(mode)) mode = "edit";

  $app.innerHTML = `
  <div class="viewer">
    <div class="vbar">
      <button class="icon-btn" id="back" aria-label="Volver">←</button>
      <input class="title" id="title" value="${esc(img.title || "")}" placeholder="Título (ej: Codo lateral)" />
      <div class="seg" id="seg">
        <button data-m="edit">Editar</button><button data-m="study">Estudiar</button><button data-m="quiz">Quiz</button>
      </div>
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
        labels: labels.filter((l) => (l.text || "").trim() || l.id === sel),
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
      ${mode === "edit" && l.tx != null ? `<div class="tip" data-id="${l.id}" style="left:${l.tx * 100}%;top:${l.ty * 100}%"></div>` : ""}`).join("");
    drawArrows();
  }
  function drawArrows() {
    if (!baseW) return;
    const shown = mode === "edit" ? labels : withText(labels);
    const sw = Math.max(fs * 0.09, 1.5), hl = fs * 0.55;
    svg.innerHTML = shown.filter((l) => l.tx != null).map((l) => {
      const el = lbls.querySelector(`.lbl[data-id="${l.id}"]`);
      if (!el) return "";
      const cx = l.x * baseW, cy = l.y * baseH, ex = l.tx * baseW, ey = l.ty * baseH;
      const w = el.offsetWidth / 2 + fs * 0.15, h = el.offsetHeight / 2 + fs * 0.15;
      const dx = ex - cx, dy = ey - cy;
      const len = Math.hypot(dx, dy);
      if (len < 1) return "";
      const t = Math.min(dx ? w / Math.abs(dx) : Infinity, dy ? h / Math.abs(dy) : Infinity);
      if (t >= 1) return ""; // la punta queda dentro del rótulo
      const sx = cx + dx * t, sy = cy + dy * t;
      const ux = dx / len, uy = dy / len, a = 0.45;
      const h1x = ex - hl * (ux * Math.cos(a) - uy * Math.sin(a)), h1y = ey - hl * (uy * Math.cos(a) + ux * Math.sin(a));
      const h2x = ex - hl * (ux * Math.cos(a) + uy * Math.sin(a)), h2y = ey - hl * (uy * Math.cos(a) - ux * Math.sin(a));
      return `<path d="M${sx},${sy} L${ex},${ey} M${h1x},${h1y} L${ex},${ey} L${h2x},${h2y}"
        stroke="${l.color}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"
        style="filter:drop-shadow(0 0 ${sw}px rgba(0,0,0,.7))"/>`;
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
    if (m === "study") revealed.clear();
    if (m === "quiz") startQuiz();
    else quiz = null;
    renderTools();
    renderBottom();
    renderLabels();
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
        <span class="hint">👆 Toca la estructura para poner un rótulo · arrastra el rótulo o la punta ⚪ para moverlos</span>
        <button class="btn small" id="undo" ${undoStack.length ? "" : "disabled"}>↶ Deshacer</button>
        <label class="size">Aa <input type="range" id="size" min="0.5" max="2" step="0.1" value="${labelSize}" /></label>
        <select id="move" aria-label="Mover a carpeta">
          ${allDecks.map((d) => `<option value="${d.id}" ${d.id === img.deck_id ? "selected" : ""}>📁 ${esc(d.name)}</option>`).join("")}
        </select>
        <button class="btn small danger" id="delImg">🗑 Borrar imagen</button>`;
      tools.querySelector("#undo").onclick = undo;
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
    renderBottom();
    scheduleSave();
  }
  function renderBottom(focus) {
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
      note.onkeydown = (e) => e.key === "Enter" && deselect();
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
      input.onkeydown = (e) => e.key === "Enter" && deselect();
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
      if (focus) input.focus();
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
      ans.focus({ preventScroll: true });
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
      next.focus();
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
    const tip = e.target.closest(".tip"), lb = e.target.closest(".lbl");
    const kind = tip ? "tip" : lb ? "lbl" : "bg";
    const id = (tip || lb)?.dataset.id;
    const l = labels.find((x) => x.id === id);
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
      if (mode === "edit" && g.kind !== "bg" && g.id) snap();
    }
    const l = labels.find((x) => x.id === g.id);
    if (mode === "edit" && l && g.kind === "lbl") {
      l.x = clamp(g.l0.x + dx / (baseW * view.s), 0, 1);
      l.y = clamp(g.l0.y + dy / (baseH * view.s), 0, 1);
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
    else if (g.moved && mode === "edit" && g.kind !== "bg") scheduleSave();
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
      if (gg.kind !== "bg") {
        if (sel === gg.id) return;
        if (sel) deselect();
        return select(gg.id);
      }
      if (sel) return deselect();
      const p = toNorm(e.clientX, e.clientY);
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      const up = p.y > 0.2;
      const l = {
        id: newId(), text: "", color: lastColor,
        x: clamp(p.x + 0.06, 0.08, 0.92), y: clamp(p.y + (up ? -0.14 : 0.14), 0.05, 0.95),
        tx: p.x, ty: p.y, ok: 0, fail: 0,
      };
      snap();
      labels.push(l);
      select(l.id, true, true);
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
  if (document.fonts?.ready) document.fonts.ready.then(drawArrows);

  cleanup = async () => {
    removeEventListener("resize", onResize);
    if (saveT) await saveNow();
  };
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
