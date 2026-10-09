# snapshots/ — sandbox de salida local de `edit-profile.js --mode snapshot --out`

Directorio **dedicado y excluyente**: `--out` solo acepta rutas que resuelvan
dentro de esta carpeta y terminadas en `.json`. Cualquier otra ruta (absoluta,
relativa con `..`, otro directorio, otro sufijo) se rechaza con **exit 2**.

Reglas (fail-closed, comprobadas por `validate.js`):

- **No se sobrescribe** un archivo existente salvo con `--allow-overwrite`
  (flag explícito, solo con `--mode snapshot --out`).
- El contenido del snapshot está **enmascarado**: cada valor es un descriptor
  `{__masked__, kind, len, sha256}` — nunca texto crudo del perfil.
- Es salida **local** de snapshot: no toca el perfil en vivo y no requiere
  `--apply`. No hay red ni navegador en ninguna parte de la herramienta.
- Estos archivos son artefactos locales: `.gitignore` de esta carpeta excluye
  todo salvo el `.gitignore` y este `README.md` — no se versionan.

Uso:

```powershell
cd linkedin-sync\scripts
node edit-profile.js --mode snapshot --out ..\snapshots\perfil.json
node edit-profile.js --mode snapshot --out ..\snapshots\perfil.json --allow-overwrite
node edit-profile.js --mode verify --snapshot-file ..\snapshots\perfil.json
```

*Fecha de la regla: 2026-10-06 (fix round 3 de la auditoría de seguridad).*
