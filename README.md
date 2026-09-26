# Rotulado 🩻

Página para rotular radiografías y estudiarlas tapando las respuestas (*image occlusion*).

- **Editar:** tocas la estructura y escribes el nombre. Se crea un rótulo con flecha que puedes arrastrar, y también puedes mover la punta ⚪.
- **Estudiar:** los rótulos quedan tapados. Tocas uno para destaparlo, o usas *Mostrar todo* y *Tapar todo*.
- **Quiz:** parpadea un rótulo y escribes el nombre. No importan las tildes ni las mayúsculas, y te avisa si solo fue un error de ortografía. Se guarda tu progreso y los que fallas pasan a **difíciles**.
- **Carpetas:** con *Quiz de toda la carpeta* y *Repasar difíciles*.
- Cada persona tiene **su propia cuenta**: sus fotos, rótulos y progreso son privados.
- Zoom con dos dedos, y las fotos se comprimen al subirlas.

## Puesta en marcha

### 1. Publicar en GitHub Pages
En el repositorio ve a **Settings → Pages**. En *Branch* elige `main` y la carpeta `/ (root)`, y luego **Save**.
En 1–2 minutos queda en `https://malisteee.github.io/rotulado-/`.

Sin Supabase la página funciona en **modo prueba**, y todo se guarda solo en ese dispositivo.

### 2. Conectar Supabase (cuentas y fotos en la nube)
1. Crea un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, pega todo `supabase/schema.sql` y ejecútalo con **Run**.
3. **Authentication → URL Configuration**: en *Site URL* pon `https://malisteee.github.io/rotulado-/`.
4. **Project Settings → API**: copia *Project URL* y la *anon public key* en `config.js`.
   ⚠️ Nunca uses la `service_role` key.

### 3. Instalar en el iPad
Abre la página en Safari, toca **Compartir → Agregar a pantalla de inicio**, y queda como una app.

## Archivos
| Archivo | Qué hace |
|---|---|
| `index.html`, `styles.css` | Estructura y diseño |
| `app.js` | Pantallas: carpetas, editor, estudio y quiz |
| `db.js` | Guardado en Supabase o modo prueba local |
| `config.js` | Datos de tu proyecto Supabase |
| `supabase/schema.sql` | Tablas, reglas de privacidad y bucket de fotos |
