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

# Migracja zadań archiwizacji (archive_jobs)

Tabele kolejki zadań, rejestru workerów i dziennika awaryjnego dla kompresora (`projecto-compress`) oraz indeks `archive_jobs_one_active_idx`, który wymusza, że w danym momencie istnieje co najwyżej jedno zadanie w stanie `queued` lub `running`. Migracja jest idempotentna (można ją powtarzać):

```
# najpierw podgląd (wypisuje instrukcje SQL, nic nie zmienia)
DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-archive-jobs.mjs --dry-run

DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-archive-jobs.mjs
```

Opcja `--dry-run` z ustawionym `DB_URL` łączy się z bazą i wykonuje wyłącznie odczyty (SELECT z `pg_tables` i `pg_indexes`).

Alternatywnie, samym SQL-em:

```
psql "$DB_URL" -f db/migrations/2026-11-19_archive_jobs.sql
```

Wycofanie zmian jest opisane w komentarzu `rollback` na końcu pliku SQL. Usuwa ono tabele wraz z danymi, więc wykonuj je tylko wtedy, gdy żadne zadanie archiwizacji nie jest w toku.

# Worker archiwizacji (archiver-worker)

Kompresja plików zleceń działa w osobnym kontenerze `archiver-worker` (Bun, kod archiwizatora w JS i program `projecto-compress` napisany w C++, zlinkowany statycznie z zstd 1.5.7 i brotli 1.2.1). Kontener web tylko dodaje zadanie do kolejki (`archive_jobs` w Postgresie) i odczytuje jego stan; dekompresja przy pobieraniu nadal odbywa się w procesie web. Opis protokołu i parametrów: `phases-bugfix/phase4.md` oraz `phases-bugfix/phase4-amendments.md` (poprawki mają pierwszeństwo), program: `native/compressor/README.md`.

Parametry kompresji zależą tylko od rozmiaru pliku, a limit pamięci nigdy ich nie obniża. Plik, który nie mieści się w limicie, kończy się błędem dla danego kodeka (kod wyjścia 4), a nie słabszą kompresją.

## Budowanie obrazu

Wersje i skróty (digesty) obrazów bazowych są w `docker/versions.env`. Obraz buduje się z korzenia repozytorium, z czystego checkoutu (etykieta rewizji musi odpowiadać commitowi):

```
set -a; . docker/versions.env; set +a
GIT_SHA=$(git rev-parse HEAD)
docker build -f docker/archiver-worker.Dockerfile \
  --build-arg BUN_VERSION --build-arg BUN_ALPINE_DIGEST \
  --build-arg ALPINE_VERSION --build-arg ALPINE_DIGEST \
  --build-arg GIT_SHA="$GIT_SHA" \
  -t "projecto-archiver-worker:$GIT_SHA" .
```

- Etap `native` uruchamia `ctest`; jeśli testy nie przejdą, budowanie się przerywa. Pobiera też zstd, brotli i doctest (CMake sprawdza ich SHA256), więc wymaga dostępu do sieci.
- `BUN_VERSION` musi być taka sama jak w obrazie web (dekoder w workerze i w web to ten sam kod `createDecompressStream` na `node:zlib`). Sprawdź: `docker run --rm --entrypoint bun <obraz-web> --version`.
- Obraz działa jako użytkownik `10001`, nie zawiera plików `.env`, a `.dockerignore` w korzeniu repozytorium wyklucza `.env*`, `.git`, `node_modules`, `archiver-recovery`, `graphify-out`, `.claude` i `phases-bugfix`. `.dockerignore` obowiązuje także przy budowaniu obrazu web z tego samego kontekstu.
- Skrót obrazu bazowego odświeżasz zapytaniem do rejestru (nagłówek `Docker-Content-Digest`), a zmianę tagu i skrótu wprowadzasz razem, w osobnym commicie:

```
T=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:oven/bun:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -sI -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/oven/bun/manifests/1.4.4-alpine | grep -i docker-content-digest
```

## Zmienne środowiskowe workera

Sekrety trafiają do pliku wskazanego w `env_file` na hoście (poza repozytorium i poza obrazem).

| Zmienna | Wymagana | Opis |
| --- | --- | --- |
| `DB_URL` | tak | Adres Postgresa. Najlepiej dedykowana rola: `SELECT, UPDATE(archived_at)` na `orders` i pełny dostęp do tabel `archive_*`. |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | tak | Dostęp do MinIO. Najlepiej dedykowany klucz ograniczony do koszyka z plikami zleceń. Worker bez którejś z tych zmiennych nie startuje. |
| `COMPRESSOR_MEMORY_BUDGET_MIB` | nie | Budżet pamięci programu `projecto-compress`, 64 do 7168, domyślnie `6144`. Nie ustawiaj go powyżej `mem_limit` minus 1024 MiB. Zła wartość zatrzymuje start. |
| `COMPRESSOR_TIMEOUT_MS` | nie | Limit czasu jednego uruchomienia kodeka, domyślnie `10800000` (3 godziny). |
| `DB_POOL_MAX` | nie | Rozmiar puli połączeń, w compose `3`. |
| `ARCHIVER_WORKER_ID` | nie | Nazwa workera w tabeli `archive_workers`, domyślnie `<hostname>:<pid>`. |
| `ARCHIVER_VERSION` | nie | Ustawiana w obrazie na `GIT_SHA`; widać ją w kolumnie `archive_workers.version` razem z wersją `projecto-compress`. |
| `LOG_LEVEL` | nie | Poziom logowania. |

Ustawione w obrazie i zwykle bez zmian: `TMPDIR=/work/tmp`, `ARCHIVER_RECOVERY_DIR=/work/recovery`, `PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress`, `NODE_ENV=production`.

## Wolumeny

| Ścieżka w kontenerze | Wolumen | Uwagi |
| --- | --- | --- |
| `/work/tmp` | `archiver-work` | Katalog tymczasowy: pobrany oryginał i oba kandydaty (do ok. 750 MiB na plik w obróbce). Musi być wolumenem na dysku, **nie tmpfs** (tmpfs liczy się do limitu pamięci kontenera). Musi przetrwać restart, bo zachowany oryginał jest podstawą dziennika awaryjnego. |
| `/work/recovery` | `archiver-recovery` | Katalog odzyskiwania (`ARCHIVER_RECOVERY_DIR`), patrz niżej. |

Nazwane wolumeny dziedziczą właściciela (`10001`) z obrazu. Przy katalogach z hosta (bind mount) ustaw właściciela ręcznie: `chown -R 10001:10001 <katalog>`.

## Compose

Plik compose aplikacji web nie jest w tym repozytorium. Dodaj usługę na serwerze (`GIT_SHA` to pełny skrót commitu, taki sam jak tag obrazu):

```yaml
services:
  archiver-worker:
    image: projecto-archiver-worker:${GIT_SHA}
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs: ["/tmp:size=16m"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 8g
    memswap_limit: 8g          # bez swapu: kontener ma paść szybko, a nie zamulać hosta
    cpus: "1.0"
    pids_limit: 64
    stop_grace_period: 2m
    env_file: /srv/projecto/secrets/archiver-worker.env   # DB_URL, MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY
    environment:
      COMPRESSOR_MEMORY_BUDGET_MIB: "6144"
      COMPRESSOR_TIMEOUT_MS: "10800000"
      DB_POOL_MAX: "3"
    volumes:
      - archiver-work:/work/tmp
      - archiver-recovery:/work/recovery
    networks: [backend]        # tylko Postgres i MinIO, bez publikowanych portów

volumes:
  archiver-work:
  archiver-recovery:

networks:
  backend:
    external: true   # istniejąca sieć kontenera web, z Postgresem i MinIO
```

`mem_limit` to pułap, a nie rezerwacja: między zadaniami worker zajmuje dobrze poniżej 100 MiB. Szczyt rzędu 2,5 GiB występuje tylko podczas kompresji pliku większego niż 128 MiB. Budżet 6144 MiB, proces Bun (ok. 350 do 600 MiB) i zapas jądra mieszczą się w 8 GiB; nie zmniejszaj `mem_limit` bez obniżenia budżetu. Limit `pids_limit: 64` jest przyjęty z planu, a W27 musi potwierdzić, że wystarcza (Bun i kolejne uruchomienia `projecto-compress`). Wartość `DOWNLOAD_DECODE_BUDGET_MIB` w kontenerze web sprawdź względem limitu pamięci tego kontenera.

## Kolejność wdrożenia

Obraz web ze zmienionym dekoderem (`createDecompressStream`: okno zstd 28 i brotli large-window) musi trafić na serwer **przed** pierwszym uruchomieniem workera. Stary obraz web nie pobierze pliku, który worker skompresował z oknem 28 lub w trybie large-window.

1. **R0**: wydanie samego web z nowym dekoderem. Nadal kompresuje w procesie, starymi ustawieniami; jego wynik dekoduje się bez problemu.
2. Migracja bazy (sekcja "Migracja zadań archiwizacji"). Jest addytywna, stary kod ignoruje nowe tabele.
3. Uruchom `archiver-worker`. Czeka na zadania i wysyła heartbeat.
4. Skopiuj istniejące pliki z katalogu odzyskiwania kontenera web do wolumenu `archiver-recovery` (patrz niżej). Nie usuwaj oryginałów.
5. Wdróż web z nowymi trasami kolejki. Jeśli stary proces web wykonuje w tej chwili zadanie, nadal trzyma blokadę (`ARCHIVE_LOCK_KEY`), więc worker poczeka, aż ono się skończy.
6. Sprawdź rewizję uruchomionych obrazów (patrz niżej).

## Katalog odzyskiwania (przeniesienie)

Do tej pory `ARCHIVER_RECOVERY_DIR` był katalogiem kontenera web; teraz używa go worker (`/work/recovery`). Skopiuj dotychczasowe pliki `<id>.orig` i `<id>.json` do wolumenu `archiver-recovery`, a oryginały zostaw na miejscu:

```
# kopia z kontenera web na hosta
docker cp <kontener-web>:<ARCHIVER_RECOVERY_DIR>/. ./archiver-recovery-copy

# z hosta do wolumenu (ten sam obraz co worker, jako root tylko na czas kopiowania)
docker run --rm --user 0 --entrypoint sh \
  -v "$PWD/archiver-recovery-copy:/from:ro" -v archiver-recovery:/to \
  "projecto-archiver-worker:$GIT_SHA" -c 'cp -a /from/. /to/ && chown -R 10001:10001 /to'
```

Jeśli katalog web był wolumenem, zamiast `docker cp` zamontuj ten wolumen jako `/from:ro`. Nazwy wolumenów compose mają zwykle prefiks projektu (`docker volume ls`). Pliki nie są usuwane automatycznie. Wpisy, które wymagają ręcznego sprawdzenia, panel administratora pokazuje jako licznik.

## Porzucone wieloczęściowe uploady (MinIO)

Przerwane uploady multipart zostawiają części w koszyku. Plan zakłada regułę `AbortIncompleteMultipartUpload` po 7 dniach, ale **MinIO jej nie obsługuje** (parser reguł cyklu życia ją pomija, a `mc ilm rule add` nie ma takiej opcji). MinIO sprząta takie uploady samo: domyślnie po 24 godzinach, co 6 godzin. Żeby ustawić 7 dni, zmień ustawienie na poziomie całego serwera (dotyczy to także uploadów z `multipartUpload.js`):

```
mc admin config set <alias> api stale_uploads_expiry=168h
mc admin config get <alias> api
```

Domyślne 24 godziny też są poprawne i zwykle wystarczą. Jeśli używasz magazynu zgodnego z S3, który obsługuje regułę (np. AWS S3), ustaw ją tak:

```
aws s3api put-bucket-lifecycle-configuration --bucket <koszyk> --lifecycle-configuration \
  '{"Rules":[{"ID":"abort-incomplete-multipart","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

## Rewizja uruchomionego obrazu

Po każdym wdrożeniu sprawdź, że kontenery działają z obrazów zbudowanych z oczekiwanego commitu (produkcja już raz działała na starym buildzie):

```
git rev-parse HEAD
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <kontener-archiver-worker>
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "projecto-archiver-worker:$GIT_SHA"
```

Wszystkie trzy wartości muszą być równe. Ten sam skrót widać w bazie: `SELECT worker_id, version, heartbeat_at FROM archive_workers;` (kolumna `version` ma postać `<skrót> / projecto-compress 1.0.0 zstd 1.5.7 brotli 1.2.1`).

Sprawdzenia samego obrazu:

```
docker run --rm --entrypoint id "projecto-archiver-worker:$GIT_SHA"           # uid=10001
docker run --rm --entrypoint projecto-compress "projecto-archiver-worker:$GIT_SHA" --version
docker run --rm --entrypoint sh "projecto-archiver-worker:$GIT_SHA" -c 'ls -a /app'   # bez plików .env
```

## Wycofanie zmian

1. Zanim cokolwiek wycofasz, rozstrzygnij wpisy `archive_pending_verify`: uruchom workera jeszcze raz (dokończy przerwane sprawdzenia i w razie potrzeby przywróci oryginał) albo sprawdź wiersze ręcznie.
2. Wdróż poprzedni obraz web, ale **nigdy starszy niż R0**. Od chwili, gdy worker zarchiwizował pierwszy plik, obiekty w koszyku mogą mieć okno zstd 28 lub brotli large-window, a obrazy starsze niż R0 ich nie pobiorą.
3. Zatrzymaj `archiver-worker`. Tabele `archive_*` są nieszkodliwe i można je zostawić; usunięcie opisuje komentarz `rollback` w pliku SQL migracji.

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
