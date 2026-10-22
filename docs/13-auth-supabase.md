# Inicio de sesión con Supabase

La app ya puede comprobar el correo y la contraseña contra Supabase Auth. En el primer acceso crea o actualiza la cuenta puente local para conservar el funcionamiento offline.

En Netlify, en **Site configuration → Environment variables**, agrega:

- `VITE_SUPABASE_URL` = `https://xyrethovmussutonofcc.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY` = la clave `sb_publishable_...` del proyecto

Después publica un nuevo deploy. La tabla `public.perfiles` debe tener una fila con el mismo UUID del usuario y la política de lectura que ya ejecutaste. La clave `service_role` nunca se pone en el navegador.

Si las variables no están configuradas, la app sigue usando el inicio de sesión local para desarrollo.
