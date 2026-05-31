# Quality Gates · Cocoa Migration

Estos son los criterios para considerar la migracion DONE-DONE-DONE.

## Checklist tecnico
- [x] Todos los componentes Cocoa typecheck OK
- [x] Backend prefs endpoint funcional
- [x] Backend shortcuts catalog funcional
- [x] 36 iconos creados sin warnings TS
- [x] CSS tokens en light + dark coherentes
- [ ] Wire CocoaGlobalProvider en App.tsx (pendiente W6 finish)
- [ ] Visual smoke test en navegador
- [ ] Lighthouse score > 90 perf
- [ ] A11y audit score > 95

## Checklist diseño
- [x] Tokens spacing 4/8/12/16/24/32/48/64
- [x] Tokens radius 4/6/8/10/14/16/20
- [x] Tokens shadow xs/sm/md/lg/xl
- [x] Typography escala 11 niveles (large-title → caption-2)
- [x] Color palette 10 accent + neutrals + semantic
- [x] Motion 4 spring presets + 5 duration tokens

## Checklist documentacion
- [x] EXECUTIVE-SUMMARY.md (para CEO)
- [x] CHEAT-SHEET.md (para developers)
- [x] INTEGRATION-GUIDE.md
- [x] INDEX.md maestro
- [x] 7 migration plans
- [x] CHANGELOG.md
- [x] MIGRATION-STATUS.md
- [x] RELEASE-NOTES.md
- [x] QUALITY-GATES.md (este doc)

## Checklist testing
- [x] 214/214 tests baseline PASS
- [ ] Component tests Cocoa (TBD)
- [ ] E2E test login + dashboard Cocoa (TBD)
- [ ] Visual regression baseline (TBD)

## Aprobacion
- [ ] Design review aprobado
- [ ] Code review aprobado
- [ ] QA functional aprobado
- [ ] Pilot hotel feedback OK

## Cuando es DONE
Cuando todos los items checklist tienen [x]. Actualmente: ~70% completo.

## Lo que viene
- W6 termina migracion screens
- Wire provider en App.tsx
- Screenshot visual smoke test
- Pilot test en hotel real
