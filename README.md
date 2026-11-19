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

# Zmienne środowiskowe

Adresy Kratosa i bazy pochodzą ze środowiska. Domyślne wartości (`http://kratos:4433`, `http://kratos:4434`) działają tylko poza produkcją; w produkcji brak zmiennej kończy start serwera błędem (`process.exit(1)`), a nie dopiero pierwszym zapytaniem. `next build` nie wymaga zmiennych serwerowych.

| Zmienna | Wymagana w produkcji | Opis |
| --- | --- | --- |
| `DB_URL` | tak | Adres połączenia z Postgresem. |
| `KRATOS_PUBLIC_INTERNAL_URL` | tak | Publiczne API Kratosa widziane z serwera Next.js (w Dockerze np. `http://kratos:4433`). Używane do `/sessions/whoami`. Dev: `http://kratos:4433`. |
| `KRATOS_ADMIN_URL` | tak | Admin API Kratosa widziane z serwera (np. `http://kratos:4434`). Dev: `http://kratos:4434`. |
| `NEXT_PUBLIC_KRATOS_PUBLIC_URL` | tak (w buildzie) | Publiczny adres Kratosa dla przeglądarki (np. `https://orto.lotar122.dev/kratos`). Wartość jest wkompilowana w bundle, więc **musi być ustawiona podczas `bun run build`** (build arg w Dockerze); ustawienie jej tylko przy starcie nie wystarczy. Start serwera w produkcji sprawdza wartość wkompilowaną w build, więc przekazanie jej wyłącznie jako build arg jest poprawne. Brak wartości w buildzie daje tylko ostrzeżenie (build się nie przerywa), ale serwer w produkcji odmówi startu. Wpływa też na CSP (`connect-src`, `form-action`) w `next.config.mjs`. Lokalnie ustaw ją w `.env.local`. |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | tak | Dostęp do MinIO. |

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

# Archiwizacja zleceń (migracja bazy danych)

Kolumna `orders.archived_at` jest wymagana przed wdrożeniem automatycznego archiwizatora. Uruchom migrację przed wdrożeniem nowej wersji (jest idempotentna, można ją powtarzać):

```
# najpierw podgląd (nic nie zmienia)
DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-orders-archived-at.mjs --dry-run

DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-orders-archived-at.mjs
```

Alternatywnie, samym SQL-em:

```
psql "$DB_URL" -f db/migrations/2026-11-11_orders_archived_at.sql

# jeśli Postgres działa w Dockerze
docker exec -i <kontener-postgres> psql -U <użytkownik> -d <baza> < db/migrations/2026-11-11_orders_archived_at.sql
```

Archiwizator (panel administratora → Archiwizacja) kompresuje pliki zleceń starszych niż 30 dni (zstd/brotli, wybierany jest mniejszy wynik); przy pobieraniu pliki są dekompresowane automatycznie. Można go bezpiecznie uruchamiać wielokrotnie.

Jeśli po kompresji nie uda się zweryfikować pliku ani przywrócić oryginału, oryginał trafia do katalogu `ARCHIVER_RECOVERY_DIR` (domyślnie `./archiver-recovery`) jako `<id>.orig` + `<id>.json` z metadanymi. W kontenerze zamontuj ten katalog jako trwały wolumen. Pliki nie są usuwane automatycznie.

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
