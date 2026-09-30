# Colección Liga 26/27

Web para llevar tu colección de cromos (Liga Este, Panini): cantidades por cromo, repetidos, faltas, clasificación y noticias que se actualizan solas, con usuarios y contraseña. Funciona en móvil y PC. No necesita instalar nada (solo Node 22 o superior).

## Probarla en tu ordenador
```
node server.js
```
Abre http://localhost:3000, pulsa «Registrarme» y crea tu usuario.

## Publicarla gratis en micolecionlaliga2026.onrender.com
1. Crea una cuenta gratuita en **github.com** y sube esta carpeta a un repositorio nuevo.
2. Crea una base de datos gratuita en **neon.com** (sin tarjeta) y copia la «connection string» (empieza por `postgres://`). Sirve para que los usuarios y cromos no se pierdan.
3. En **render.com** (gratis, sin tarjeta) elige *New → Blueprint*, selecciona tu repositorio y, cuando lo pida, pega la connection string en `DATABASE_URL`.
4. Render te da la dirección `https://micolecionlaliga2026.onrender.com`. Ábrela en el móvil y usa «Añadir a pantalla de inicio».

Nota: en el plan gratuito de Render la web «se duerme» tras 15 minutos sin visitas y tarda unos 30-60 segundos en despertar la primera vez.

## Cómo funciona cada parte
- **Colección**: cromos por equipo y secciones especiales (Últimos Fichajes, ADN Prime, Fantasy, Draft 23, Kromix, Extra Stickers). Botones − / + para la cantidad.
- **Repetidos**: todo lo que tienes más de una vez, con botón para copiar la lista y cambiar cromos.
- **Faltan**: lo que tienes a 0, con botón para copiar la lista.
- **Liga**: clasificación (ESPN, cada 30 min) y noticias (RSS de Marca y AS, cada 10 min).

## Escudos y fotos (de internet, no de Panini)
- **Escudos**: se cargan de ESPN (los 20 equipos).
- **Fotos de jugadores**: la web ya trae la mayoría de fotos localizadas y comprobadas (`data/photos.json`): de Wikimedia Commons (licencias libres) y de TheSportsDB. Se ven desde el primer momento. Para los pocos jugadores que faltan, el servidor sigue buscando solo en segundo plano y, si no encuentra una coincidencia segura, muestra el escudo del equipo.
- **Fotos propias** (opcional): ponlas en `public/img/` y tienen prioridad. Cromo: `<id>.jpg`, por ejemplo `barcelona-20.jpg` (el id es equipo-código sin espacios: `alaves-8BIS`, `fichajes-UF12`). Escudo: `crest-<equipo>.png`.

## Ampliar o corregir el listado
Edita `data/checklist.txt` (el formato está en las primeras líneas) y reinicia.
