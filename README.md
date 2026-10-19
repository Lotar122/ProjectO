## project o

# Aby zacząć:

zapoznaj się ze style guide oraz dokumentacją na serwerze discord

zainstaluj [bun](https://bun.sh/)

zainstaluj rozszerzenie prettier do vs code

Sklonuj repo:

```
git clone https://github.com/Lotar122/ProjectO.git
```

Zainstaluj potrzebne pakiety:

```
bun install
```

Zacznij serwer deweloperski:

```
bun run dev
```

# Rola administratora (jednorazowa migracja)

Rola jest czytana z `metadata_public.role` w Ory Kratos (użytkownik nie może jej sam zmienić). Zanim wdrożysz nową wersję, przenieś istniejących administratorów z `traits.role`:

```
# najpierw podgląd (sprawdź listę - traits.role mógł ustawić sobie sam użytkownik)
docker run --rm --network <sieć_kratosa> -e KRATOS_ADMIN_URL=http://kratos:4434 \
  -v "$PWD/scripts:/scripts:ro" node:22-alpine node /scripts/migrate-admin-role.mjs --dry-run

docker run --rm --network <sieć_kratosa> -e KRATOS_ADMIN_URL=http://kratos:4434 \
  -v "$PWD/scripts:/scripts:ro" node:22-alpine node /scripts/migrate-admin-role.mjs
```

Sieć kontenera: `docker inspect <kontener-kratos> -f '{{json .NetworkSettings.Networks}}'`. Jeśli port 4434 jest wystawiony na hoście: `KRATOS_ADMIN_URL=http://127.0.0.1:4434 bun scripts/migrate-admin-role.mjs`.

Testy: `bun run test`.

# Technologie użyte

- Bun
- Next.js
- React
- Tailwind CSS
- PostgerSQL
- S3 maybe?

# TODO

- [ ] logo
- [ ] figma prototype
- [ ] encryption
- [ ] auth
- [x] style guide
- [ ] db
- [ ] object storage?
- [ ] testing
- [ ] deployment
