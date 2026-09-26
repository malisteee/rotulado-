// Capa de datos: Supabase (en línea, con cuentas) o modo prueba local (IndexedDB).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=5";

export const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY;
const BUCKET = "radiografias";

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */
function supabaseBackend() {
  let sb;
  const urlCache = new Map(); // path -> {url, exp}

  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  return {
    async init() {
      const { createClient } = await import("./vendor/supabase.js?v=2.117.2");
      sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    },
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((event, session) => cb(session?.user ?? null, event));
    },
    async signIn(email, password) {
      must(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      const data = must(
        await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin + location.pathname },
        })
      );
      return { needsConfirm: !data.session };
    },
    async resetPassword(email) {
      must(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
    },
    async updatePassword(password) {
      must(await sb.auth.updateUser({ password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async listDecks() {
      const rows = must(await sb.from("decks").select("id,name,created_at,images(id,title,labels)").order("created_at"));
      return rows.map((d) => ({ ...d, images: d.images || [] }));
    },
    async createDeck(name) {
      return must(await sb.from("decks").insert({ name }).select().single());
    },
    async renameDeck(id, name) {
      must(await sb.from("decks").update({ name }).eq("id", id));
    },
    async deleteDeck(id) {
      const imgs = must(await sb.from("images").select("path").eq("deck_id", id));
      if (imgs.length) await sb.storage.from(BUCKET).remove(imgs.map((i) => i.path));
      must(await sb.from("decks").delete().eq("id", id));
    },
    async getDeck(id) {
      return must(await sb.from("decks").select("*").eq("id", id).single());
    },

    async listImages(deckId) {
      return must(await sb.from("images").select("*").eq("deck_id", deckId).order("created_at"));
    },
    async getImage(id) {
      return must(await sb.from("images").select("*").eq("id", id).single());
    },
    async uploadImage(deckId, blob, title, width, height) {
      const user = await this.getUser();
      const path = `${user.id}/${uid()}.jpg`;
      must(await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" }));
      return must(
        await sb
          .from("images")
          .insert({ deck_id: deckId, title, path, width, height, labels: [] })
          .select()
          .single()
      );
    },
    async updateImage(id, patch) {
      must(await sb.from("images").update(patch).eq("id", id));
    },
    async deleteImage(img) {
      await sb.storage.from(BUCKET).remove([img.path]);
      must(await sb.from("images").delete().eq("id", img.id));
    },
    async imageUrls(imgs) {
      const now = Date.now();
      const missing = imgs.filter((i) => !(urlCache.get(i.path)?.exp > now)).map((i) => i.path);
      if (missing.length) {
        const data = must(await sb.storage.from(BUCKET).createSignedUrls(missing, 3600));
        data.forEach((d) => d.signedUrl && urlCache.set(d.path, { url: d.signedUrl, exp: now + 3000e3 }));
      }
      return imgs.map((i) => urlCache.get(i.path)?.url);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Modo prueba: IndexedDB en el dispositivo                            */
/* ------------------------------------------------------------------ */
function localBackend() {
  let dbp;
  const blobUrls = new Map();
  const open = () =>
    (dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open("rotulado-demo", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("decks", { keyPath: "id" });
        db.createObjectStore("images", { keyPath: "id" });
        db.createObjectStore("blobs");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  const all = (store) => tx(store, "readonly", (s) => s.getAll());
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const put = (store, val, key) => tx(store, "readwrite", (s) => s.put(val, key));
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const byDate = (a, b) => (a.created_at < b.created_at ? -1 : 1);
  const user = { id: "demo", email: "modo prueba" };

  return {
    async init() {},
    async getUser() {
      return user;
    },
    onAuthChange() {},
    async signIn() {},
    async signUp() {
      return {};
    },
    async resetPassword() {},
    async updatePassword() {},
    async signOut() {},

    async listDecks() {
      const [decks, imgs] = await Promise.all([all("decks"), all("images")]);
      return decks.sort(byDate).map((d) => ({ ...d, images: imgs.filter((i) => i.deck_id === d.id) }));
    },
    async createDeck(name) {
      const d = { id: uid(), name, created_at: new Date().toISOString() };
      await put("decks", d);
      return d;
    },
    async renameDeck(id, name) {
      const d = await get("decks", id);
      await put("decks", { ...d, name });
    },
    async deleteDeck(id) {
      for (const i of await this.listImages(id)) await this.deleteImage(i);
      await del("decks", id);
    },
    async getDeck(id) {
      const d = await get("decks", id);
      if (!d) throw new Error("Carpeta no encontrada");
      return d;
    },
    async listImages(deckId) {
      return (await all("images")).filter((i) => i.deck_id === deckId).sort(byDate);
    },
    async getImage(id) {
      const i = await get("images", id);
      if (!i) throw new Error("Imagen no encontrada");
      return i;
    },
    async uploadImage(deckId, blob, title, width, height) {
      const img = {
        id: uid(),
        deck_id: deckId,
        title,
        path: uid(),
        width,
        height,
        labels: [],
        label_size: 1,
        created_at: new Date().toISOString(),
      };
      await put("blobs", blob, img.path);
      await put("images", img);
      return img;
    },
    async updateImage(id, patch) {
      const i = await get("images", id);
      await put("images", { ...i, ...patch });
    },
    async deleteImage(img) {
      await del("blobs", img.path);
      await del("images", img.id);
    },
    async imageUrls(imgs) {
      const out = [];
      for (const i of imgs) {
        if (!blobUrls.has(i.path)) {
          const b = await get("blobs", i.path);
          blobUrls.set(i.path, b ? URL.createObjectURL(b) : "");
        }
        out.push(blobUrls.get(i.path));
      }
      return out;
    },
  };
}

export const db = isDemo ? localBackend() : supabaseBackend();
// Datos guardados en este dispositivo antes de activar las cuentas
export const localDb = isDemo ? db : localBackend();
