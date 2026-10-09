# linkedin-sync/archive

Snapshots pre-reconciliación (estado local 2026-10-02), preservados como audit
trail antes de reconciliar contra el baseline en vivo del 2026-10-06.

- `profile-2026-10-02.json` — perfil local tal como existía antes de la
  reconciliación (headline/about/skills/languages stale respecto al perfil en vivo).
- `changes-2026-10-02.json` — los 7 proposals originales, todos `pending`.

Estos archivos son históricos: no usarlos como fuente de verdad del perfil.
La fuente vigente es `../profile.json` (baseline en vivo 2026-10-06) y
`../changes.json` (propuestas reconciliadas).

## Gap de auditoría: `scripts/edit-profile.js` pre-hardening

Dejado explícito para que el hueco del audit trail no quede solo implícito:

- El `edit-profile.js` anterior al hardening del 2026-10-06 **nunca estuvo
  trackeado por git** (`git grep -n edit-profile 33defb3` → sin coincidencias;
  el historial de commits no contiene ninguna versión previa).
- **No se encontró ninguna copia recuperable** del fichero pre-hardening: la
  búsqueda en el filesystem (`personal`, `.opencode`, `.local\share\opencode`,
  `Temp`) solo devuelve el fichero endurecido actual.
- Por eso `archive/` contiene los snapshots de `changes.json` y `profile.json`
  pero **no** una copia previa del editor: no la había que archivar.

Consecuencia revisada: el delta de la herramienta sensible de seguridad (el
editor) no es auditable contra una versión anterior; `profile.json` y
`changes.json` sí lo son. Cualquier copia que aparezca en el futuro debe
guardarse aquí antes de modificar de nuevo `scripts/edit-profile.js`.
