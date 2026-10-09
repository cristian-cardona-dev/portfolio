# LinkedIn Sync Dashboard

## Estado del Sistema

| Componente | Estado | Detalles |
|---|---|---|
| **Repositorio** | Creado | https://github.com/cristian-cardona-dev/portfolio |
| **GitHub Actions** | Pendiente | Requiere token con scope `workflow` |
| **Script Sync** | Creado | `linkedin-sync/scripts/sync-linkedin.ps1` (solo reporta; no muta LinkedIn) |
| **Editor de perfil** | Endurecido | `linkedin-sync/scripts/edit-profile.js` — dry-run por defecto; **write path DESHABILITADO** |
| **Validación local** | Creada | `linkedin-sync/scripts/validate.js` — `npm test` (offline, determinista) |
| **Perfil JSON** | Reconciliado 2026-10-06 | `linkedin-sync/profile.json` = baseline en vivo (solo lectura) |
| **Cambios JSON** | Reconciliado 2026-10-06 | `linkedin-sync/changes.json` — 0 applied, 3 obsolete, 4 needs_review |
| **Métricas JSON** | Parcial verificado | 15 views / 10 search appearances (7 días) confirmados 2026-10-06 |
| **Sync Log** | Audit trail | `linkedin-sync/sync-log.md` |
| **Snapshot previo** | Archivado | `linkedin-sync/archive/` (estado 2026-10-02) |

---

## Reconciliación 2026-10-06 (baseline en vivo, solo lectura)

Regla aplicada: **ningún proposal se marca `applied` solo porque existe en un
script local.** `applied` exige evidencia de que el valor está en el perfil en vivo.

| # | ID | Tipo | Campo | Estado | Evidencia / razón |
|---|---|---|---|---|---|
| 1 | change-001 | headline_update | headline | **obsolete** | Headline en vivo ya es "Senior Full Stack .NET Engineer \| C#, Azure, Angular & Cloud-Native APIs \| Building Scalable Systems and AI-Enabled Products" — distinto del old_value y del propuesto; perfil actualizado fuera de este workflow |
| 2 | change-002 | about_update | about | **obsolete** | About en vivo ya es narrativa .NET/Azure y URL de portafolio (texto exacto no capturado); texto propuesto (remote-first en español) desactualizado y desalineado |
| 3 | change-003 | experience_update | experience[0].description | **needs_review** | Talan presente en vivo; descripción en vivo no capturada; bullets propuestos (React/Node/TS) desalineados con posicionamiento .NET/Azure |
| 4 | change-004 | skills_add | skills | **needs_review** | Skills en vivo no capturados; stack propuesto (React/Next.js/Node/AWS) desalineado con headline .NET/Azure/Angular |
| 5 | change-005 | projects_add | projects | **needs_review** | En vivo: "AI Chat API Prototype" → HunterProX/ai-chat-app (parcialmente ya presente); cloud-dashboard y saas-mvp sin verificar |
| 6 | change-006 | location_update | location | **needs_review** | Ubicación en vivo sigue "Elche, Valencian Community, Spain"; "Colombia (Remote)" afirma reubicación — requiere confirmación humana explícita |
| 7 | change-007 | languages_update | languages[0].level | **obsolete** | Sección Languages en vivo **sin entradas**; languages[0] no existe. Las entradas locales (Inglés/German) eran datos stale y fueron archivadas |

**Resumen: 7 reconciliados — 3 obsolete, 4 needs_review, 0 applied, 0 pending.**

---

## Métricas de Impacto

| Métrica | Baseline 2026-10-02 | Verificado 2026-10-06 | Estado |
|---|---|---|---|
| Profile views/semana | 15 | 15 | Confirmado (lectura en vivo) |
| Search appearances/semana | 10 | 10 | Confirmado (lectura en vivo) |
| Recruiter messages/mes | 0 | — | No re-verificado |
| Post impressions/semana | 7 | — | No re-verificado |
| Followers | 535 | — | No re-verificado |
| Connections | 500 | — | No re-verificado |

> Nota: `metrics.json` `ab_tests.headline` sigue listando variantes propuestas
> nunca aplicadas; se conservan como propuestas, no como estado del perfil.

---

## Estructura del Repositorio (linkedin-sync/)

```
linkedin-sync/
├── archive/
│   ├── changes-2026-10-02.json   (snapshot pre-reconciliación)
│   └── profile-2026-10-02.json   (snapshot pre-reconciliación)
├── scripts/
│   ├── edit-profile.js           (hardened: dry-run por defecto, write path deshabilitado)
│   ├── validate.js               (validación local determinista, offline)
│   ├── sync-linkedin.ps1         (reporte de pendientes; no muta)
│   ├── package.json              (npm test / npm run validate)
│   └── package-lock.json
├── changes.json                  (7 proposals reconciliados + audit trail)
├── metrics.json
├── profile.json                  (baseline en vivo 2026-10-06)
├── dashboard.md                  (este archivo)
└── sync-log.md                   (log append-only)
```

---

## Validación Local (sin LinkedIn, sin Chrome, sin red)

```powershell
cd C:\Users\CARDONA\Desktop\personal\portfolio\linkedin-sync\scripts
npm test
```

Cubre: sintaxis JS, validez UTF-8, caracteres de control, detección de patrones
de secretos, integridad JSON/política de reconciliación, el comportamiento del
editor (dry-run por defecto, `--apply` rechazado, multi-campo rechazado, dry-run
bloqueado si falla un baseline guard) y la higiene de metadatos del paquete
(sin dependencias sin usar, lockfile sincronizado).

### Semántica de salida del dry-run

| Situación | Resultado | Exit |
|---|---|---|
| Todos los baseline guards pasan | `DRY-RUN OK` | 0 |
| Algún baseline guard falla | `DRY-RUN BLOCKED (n ...)` + "do NOT read this dry-run as safe to apply" | 1 |
| `--apply` | `REFUSED` (write path deshabilitado) | 3 |

Hoy los 7 proposals están reconciliados y 6 de sus `old_value` están stale, así
que el dry-run completo sale con **exit 1 por diseño**: es un resultado correcto
(no un fallo del script), no una señal de que aplicar es seguro.

---

## Cómo Usar el Sistema

### Dry-run del editor (default, seguro)
```powershell
cd linkedin-sync\scripts
node edit-profile.js                    # dry-run de todos los campos
node edit-profile.js --field headline   # dry-run de un campo
node edit-profile.js --mode verify      # consistencia local
node edit-profile.js --mode snapshot --out ..\snapshot.json   # archivo local, sin --apply
```

- El dry-run **solo lee ficheros locales**: sin red, sin navegador, sin LinkedIn.
- Si algún baseline guard falla, termina con `DRY-RUN BLOCKED` y **exit 1** (nunca
  "OK"). Exit 0 solo cuando todos los guards pasan.
- `--out` escribe un snapshot **local**: no muta el perfil en vivo y no requiere
  `--apply`. `--apply` se exige (y además queda rechazado) solo para intentar
  mutar el perfil en vivo.

### Aplicar cambios en LinkedIn
1. Aplicar **manualmente** en https://www.linkedin.com/in/cristian-cardona-dev/
2. Registrar en `changes.json`: `status` + `reconciliation.evidence` (fecha + valor en vivo observado)
3. Ejecutar `node edit-profile.js --mode verify` para confirmar consistencia local

### Detectar pendientes (solo reporte)
```powershell
cd C:\Users\CARDONA\Desktop\personal\portfolio
.\linkedin-sync\scripts\sync-linkedin.ps1
```

---

## Próximos Pasos

| # | Acción | Estado | Notas |
|---|---|---|---|
| 1 | Revisar y commitear esta reconciliación | Pendiente (controller) | Sin push sin aprobación humana |
| 2 | Re-capturar skills, certifications y descripción de Talan (lectura en vivo) | Pendiente | Solo entonces re-proponer change-003/004 |
| 3 | Confirmar si "Colombia (Remote)" es una reubicación real | Pendiente (humano) | change-006 no se aplica sin confirmación |
| 4 | Confirmar lista completa de proyectos en vivo | Pendiente | change-005 parcialmente presente |
| 5 | Agregar scope `workflow` al token | Pendiente | Requerido para GitHub Actions |
| 6 | Evaluar retirar dependencia playwright | **Hecho (2026-10-06)** | Eliminada de `package.json`; `package-lock.json` regenerado offline (`npm install --package-lock-only --offline`) y `node_modules` podado. `validate.js` la bloquea si vuelve. |

---

## Notas

- **Política `applied`:** exige evidencia de lectura en vivo; un valor en un script local nunca cuenta.
- **`--apply` vs `--out`:** `--apply` es obligatorio para intentar mutar el perfil **en vivo** (y este build lo rechaza siempre, exit 3); `--out` es salida de snapshot **local** a propósito y no necesita `--apply`.
- **Write path del editor:** deshabilitado a propósito (selectores inestables de LinkedIn). Cualquier re-habilitación requiere implementación revisada por humano que falle en selectores ambiguos o página inesperada.
- **Credenciales:** ninguna debe (ni puede) vivir en estos archivos; la validación las detecta.
- **Perfil LinkedIn:** https://www.linkedin.com/in/cristian-cardona-dev/
- **Última actualización:** 2026-10-06 (reconciliación read-only)
