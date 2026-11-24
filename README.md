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
| `MINIO_CA_FILE` | nie | Ścieżka do pliku PEM z urzędem certyfikacji (lub pakietem CA), który podpisał certyfikat MinIO. Dla endpointu `https://` z certyfikatem własnym lub prywatnym CA; zastępuje systemową listę CA tylko dla połączeń z MinIO. Certyfikat musi zawierać host z `MINIO_ENDPOINT` w `subjectAltName`. Nie łącz z `MINIO_TLS_INSECURE` (taka konfiguracja jest odrzucana). |
| `MINIO_TLS_INSECURE` | nie | `1` lub `true` wyłącza weryfikację certyfikatu TLS MinIO. Niezalecane: każdy na trasie sieciowej może czytać i zmieniać pliki, używaj tylko lokalnie w developmentcie. Ostrzeżenie trafia do logów przy pierwszym utworzeniu klienta S3 (pierwsze użycie MinIO, nie start procesu) i tylko dla endpointu `https://`; dla `http://` zmienna jest ignorowana. Nie łącz z `MINIO_CA_FILE`: taka konfiguracja jest odrzucana przy tym samym pierwszym użyciu, też tylko dla `https://`. |
| `ARCHIVER_MODE` | nie | Domyślnie (zmienna nieustawiona) serwer web uruchamia worker archiwizacji jako nadzorowany proces potomny (sekcja "Worker archiwizacji"). Tylko `off` wyłącza worker; `embedded` jest równoważne wartości domyślnej, a inna wartość kończy start serwera błędem w produkcji. Bez workera kolejka archiwizacji nie jest przetwarzana i trasy kolejki odpowiadają `503 ARCHIVER_WORKER_OFFLINE`, więc `off` nie jest wspieranym wdrożeniem. |
| `ARCHIVER_BUN_BIN` | nie | Polecenie Buna dla nadzorcy, gdy serwer web działa na Node.js, domyślnie `bun` z `PATH`. Gdy web działa na Bunie (obraz Dockera), używany jest ten sam plik wykonywalny. |
| `ARCHIVER_STOP_GRACE_MS` | nie | Ile ms czekać po `SIGTERM` na zakończenie workera, zanim dostanie `SIGKILL`. Dodatnia liczba całkowita, domyślnie `100000` (100 s); zła wartość zatrzymuje start. Sam worker kończy się wcześniej, po upływie tej wartości pomniejszonej o `min(10 s, jedna dziesiąta)` (domyślnie po 90 s), żeby zdążyć zamknąć połączenie z blokadą i kompresor przed `SIGKILL`. Limit zatrzymania kontenera (`docker stop -t`, `stop_grace_period`) ustaw wyżej niż ta wartość, np. `120` s. |
| `ARCHIVER_LIVENESS_FILE` | nie | Bezwzględna ścieżka pliku, który worker nadpisuje po każdym udanym heartbeacie do bazy (co 10 s); `HEALTHCHECK` sprawdza jego czas modyfikacji. Obraz ustawia `/work/run/archiver-alive`. Ścieżka względna zatrzymuje start workera. Bez tej zmiennej worker nie zapisuje pliku, a sprawdzenie zdrowia (gdy działa nadzorca, czyli `ARCHIVER_MODE` jest nieustawiona, pusta lub `embedded`) kończy się niepowodzeniem. Katalog musi być zapisywalny dla użytkownika `10001`; obraz deklaruje `/work/run` jako `VOLUME`, więc działa też przy `read_only: true`, a tmpfs (`uid=10001,gid=10001`) jest zalecany. |
| `ARCHIVER_LIVENESS_MAX_AGE_MS` | nie | Czyta ją tylko `HEALTHCHECK`, nie worker: jak stary może być plik z `ARCHIVER_LIVENESS_FILE`, żeby kontener był nadal zdrowy. Dodatnia liczba całkowita ms, domyślnie `60000` (sześć pominiętych heartbeatów). Zła wartość też daje stan niezdrowy. |
| `NEXT_MANUAL_SIG_HANDLE` | nie | Ustawia ją entrypoint `docker/web-supervised.Dockerfile` (na `1`), gdy `ARCHIVER_MODE` jest nieustawiona, pusta lub `embedded` (czyli gdy działa nadzorca); zwykle nie ustawiasz jej ręcznie. Poza Dockerem (np. `bun run start`) ustaw `NEXT_MANUAL_SIG_HANDLE=1` samodzielnie, inaczej `next start` kończy proces od razu po `SIGTERM` / `SIGINT`, bez czekania na zatrzymanie workera. Każda niepusta wartość sprawia, że `next start` nie rejestruje własnych handlerów `SIGTERM` i `SIGINT` (inaczej kończyłby proces od razu i zabijał worker w trakcie zadania), a nadzorca archiwizatora obsługuje oba sygnały sam: zatrzymuje worker i dopiero wtedy kończy proces kodem `128` + numer sygnału. |
| `ARCHIVER_RECOVERY_DIR` | nie | Katalog na oryginały, których nie udało się zweryfikować ani przywrócić. Domyślnie `./archiver-recovery`; obraz ustawia `/work/recovery`. |
| `PROJECTO_COMPRESSOR_BIN` | tak (w produkcji) | Bezwzględna ścieżka wykonywalnego programu `projecto-compress`. Bez niej (lub ze ścieżką, której nie da się uruchomić) serwer w produkcji kończy start kodem 1. Obraz web ustawia `/usr/local/bin/projecto-compress`. |
| `DOWNLOAD_DECODE_BUDGET_MIB` | nie | Budżet pamięci naraz dekompresowanych pobrań w procesie web (jedno okno na pobranie). Domyślnie `768`, minimum `272` (największe okno zstd 2^28 plus 16 MiB narzutu). Zła wartość powoduje błąd 500 przy każdym pobraniu, dopóki jej nie poprawisz. |
| `ALLOWED_ORIGINS` | nie | Lista dozwolonych źródeł (`Origin`) oddzielonych przecinkami, dla ochrony CSRF tras zapisujących dane. |
| `KRATOS_IDENTITY_SCHEMA_ID` | nie | Identyfikator schematu tożsamości Kratosa używany przy tworzeniu użytkowników w panelu administratora, domyślnie `default`. |

# Rola administratora (jednorazowa migracja)

Rola jest czytana z `metadata_public.role` w Ory Kratos (użytkownik nie może jej sam zmienić). Zanim wdrożysz nową wersję, przenieś istniejących administratorów z `traits.role`:

```
# najpierw podgląd (sprawdź listę - traits.role mógł ustawić sobie sam użytkownik)
docker run --rm --network <sieć_kratosa> -e KRATOS_ADMIN_URL=http://kratos:4434 \
  -v "$PWD/scripts:/scripts:ro" node:22-alpine node /scripts/migrate-admin-role.mjs --dry-run

docker run --rm --network <sieć_kratosa> -e KRATOS_ADMIN_URL=http://kratos:4434 \
  -v "$PWD/scripts:/scripts:ro" node:22-alpine node /scripts/migrate-admin-role.mjs --apply
```

Sieć kontenera: `docker inspect <kontener-kratos> -f '{{json .NetworkSettings.Networks}}'`. Jeśli port 4434 jest wystawiony na hoście, skrypt możesz uruchomić bezpośrednio Bunem. Bez flagi `--apply` jest to próba na sucho (nic nie zapisuje; `--dry-run` też wymusza taki tryb i ma pierwszeństwo nad `--apply`):

```
# podgląd
KRATOS_ADMIN_URL=http://127.0.0.1:4434 bun scripts/migrate-admin-role.mjs

# zapis
KRATOS_ADMIN_URL=http://127.0.0.1:4434 bun scripts/migrate-admin-role.mjs --apply
```

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

Migracja składa się z dwóch plików SQL, które skrypt wykonuje po kolei:

- `db/migrations/2026-11-19_archive_jobs.sql`: tabele kolejki zadań, rejestru workerów i dziennika awaryjnego dla kompresora (`projecto-compress`) oraz indeks `archive_jobs_one_active_idx`, który wymusza, że w danym momencie istnieje co najwyżej jedno zadanie w stanie `queued` lub `running`.
- `db/migrations/2026-11-20_archive_pending_verify_job_fk.sql`: klucz obcy `archive_pending_verify.job_id` z jawnym `ON DELETE RESTRICT` oraz indeks `archive_pending_verify_job_id_idx`. Poprzedni klucz (bez klauzuli `ON DELETE`, czyli `NO ACTION`) już blokował takie usunięcia, więc migracja nie zmienia zachowania, tylko jawnie zapisuje intencję `RESTRICT`; praktyczną zmianą jest indeks, który przyspiesza sprawdzanie klucza. Wiersz dziennika awaryjnego jest jedynym śladem oryginału, który mógł nie zostać jeszcze zweryfikowany ani przywrócony, dlatego zadanie nie zabiera swoich wierszy dziennika ze sobą: `DELETE` na `archive_jobs` kończy się błędem, dopóki jakiś wiersz `archive_pending_verify` wskazuje na to zadanie. Żeby usunąć stare zadanie, najpierw rozstrzygnij jego wpisy dziennika (pozwól workerowi je dokończyć albo sprawdź wpisy `needs_attention` ręcznie), usuń je, a dopiero potem usuń zadanie.

Obie migracje są idempotentne (można je powtarzać):

```
# najpierw podgląd (wypisuje instrukcje SQL, nic nie zmienia)
DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-archive-jobs.mjs --dry-run

DB_URL=postgres://użytkownik:hasło@host:5432/baza bun scripts/migrate-archive-jobs.mjs
```

Opcja `--dry-run` z ustawionym `DB_URL` łączy się z bazą i wykonuje wyłącznie odczyty (SELECT z katalogów `pg_tables`, `pg_indexes`, `pg_constraint` i `information_schema.columns`).

Alternatywnie, samym SQL-em. Oba pliki, w tej kolejności; drugiego nie uruchamiaj z `--single-transaction`, bo `CREATE INDEX CONCURRENTLY` nie działa w transakcji:

```
psql "$DB_URL" -f db/migrations/2026-11-19_archive_jobs.sql
psql "$DB_URL" -f db/migrations/2026-11-20_archive_pending_verify_job_fk.sql

# jeśli Postgres działa w Dockerze
docker exec -i <kontener-postgres> psql -U <użytkownik> -d <baza> < db/migrations/2026-11-19_archive_jobs.sql
docker exec -i <kontener-postgres> psql -U <użytkownik> -d <baza> < db/migrations/2026-11-20_archive_pending_verify_job_fk.sql
```

Jeśli budowanie indeksu `archive_pending_verify_job_id_idx` się nie powiedzie, zostaje po nim nieważny indeks, który `IF NOT EXISTS` pominie. Skrypt usuwa go sam; ręcznie wykonaj `DROP INDEX CONCURRENTLY IF EXISTS archive_pending_verify_job_id_idx;` i ponów plik.

Wycofanie zmian jest opisane w komentarzach `rollback` na końcu obu plików SQL. Wycofanie pierwszego usuwa tabele wraz z danymi, więc wykonuj je tylko wtedy, gdy żadne zadanie archiwizacji nie jest w toku.

# Migracja znacznika usuwania zleceń (orders.deleting_at)

- `db/migrations/2026-11-20_orders_deleting_at.sql`: kolumna `orders.deleting_at timestamptz NULL`, znacznik "usuwanie w toku" ustawiany przez usuwanie zlecenia. Dopóki jest ustawiony, edycja, zmiana statusu przez administratora, kolejne usunięcie i archiwizacja tego zlecenia są odrzucane (409 `ORDER_LOCKED`). Znacznik starszy niż 15 minut (według zegara bazy danych) uznawany jest za pozostałość po przerwanym usuwaniu: przestaje blokować edycję, zmianę statusu i archiwizację, a kolejne usunięcie przejmuje zlecenie i kończy pracę.

**Migrację trzeba wykonać przed wdrożeniem nowego kodu web i workera.** Bez kolumny każda edycja i każde usunięcie zlecenia kończy się błędem. Dla tej migracji nie ma skryptu `bun`, tylko sam SQL. Jest idempotentna (można ją powtarzać) i addytywna, więc stary kod ją ignoruje:

```
psql "$DB_URL" -f db/migrations/2026-11-20_orders_deleting_at.sql

# jeśli Postgres działa w Dockerze
docker exec -i <kontener-postgres> psql -U <użytkownik> -d <baza> < db/migrations/2026-11-20_orders_deleting_at.sql
```

Plik ustawia `lock_timeout` na 5 s, żeby `ALTER TABLE` nie czekał w kolejce za długą transakcją i nie wstrzymał wszystkich zapytań do `orders`. Jeśli upłynie limit, uruchom plik ponownie. Wycofanie opisuje komentarz `rollback` na końcu pliku.

# Worker archiwizacji (wbudowany w obraz web)

Jedyna wspierana forma wdrożenia to jeden kontener `web`, zbudowany z `docker/web-supervised.Dockerfile`: Next.js na Bunie, kod archiwizatora w JS (`worker/`) i program `projecto-compress` napisany w C++, zlinkowany statycznie z zstd 1.5.7 i brotli 1.2.1. Przy starcie serwer (`src/instrumentation-node.js`) uruchamia worker jako nadzorowany proces potomny (`src/app/server-functions/orders/archiverSupervisor.js`). Nie ma osobnego kontenera workera: uruchomienie obrazu web bez workera kończy się `503 ARCHIVER_WORKER_OFFLINE` na trasach kolejki archiwizacji. Dekompresja przy pobieraniu odbywa się w procesie web. Opis protokołu i parametrów: `phases-bugfix/phase4.md` oraz `phases-bugfix/phase4-amendments.md` (poprawki mają pierwszeństwo), program: `native/compressor/README.md`.

Parametry kompresji zależą tylko od rozmiaru pliku, a limit pamięci nigdy ich nie obniża. Plik, który nie mieści się w limicie, kończy się błędem dla danego kodeka (kod wyjścia 4), a nie słabszą kompresją.

## Uruchomienie w Dockerze

Z korzenia repozytorium, z czystego checkoutu (etykieta rewizji musi odpowiadać commitowi). Sekrety runtime (`DB_URL`, `KRATOS_PUBLIC_INTERNAL_URL`, `KRATOS_ADMIN_URL`, `MINIO_*`, opcjonalnie `ALLOWED_ORIGINS`) trafiają do pliku `.env.web` obok `docker-compose.yml`; jest ignorowany przez git i nie trafia do obrazu (`.dockerignore`). Usługa `web` musi mieć dostęp do Postgresa, Kratosa i MinIO: `docker-compose.yml` podłącza ją do istniejącej sieci `backend` (inna nazwa: zmienna `BACKEND_NETWORK`).

```
GIT_SHA=$(git rev-parse HEAD) NEXT_PUBLIC_KRATOS_PUBLIC_URL=https://orto.lotar122.dev/kratos \
  docker compose --env-file docker/versions.env up -d --build
```

`docker-compose.yml` buduje `docker/web-supervised.Dockerfile`, ustawia `ARCHIVER_MODE=embedded` i `PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress` oraz `init: true`, `stop_grace_period: 2m`, limity zasobów i wolumeny (`web-work` pod `/work/tmp`, `web-recovery` pod `/work/recovery`, tmpfs pod `/work/run` i `/app/.next/cache`). Nie uruchamiaj obrazu `projecto-web` ani żadnego innego obrazu web poza tym plikiem compose i nie buduj innych Dockerfile dla web: każdy obraz bez nadzorcy i binarki `projecto-compress` daje `503 ARCHIVER_WORKER_OFFLINE`.

## Budowanie obrazu

Wersje i skróty (digesty) obrazów bazowych są w `docker/versions.env`; `docker compose --env-file docker/versions.env` przekazuje je jako argumenty budowania. Etap `native` uruchamia `ctest`; jeśli testy nie przejdą, budowanie się przerywa. Pobiera też zstd i doctest (CMake sprawdza ich SHA256) oraz brotli (przypięty commit pobierany przez `git`, który etap instaluje), więc wymaga dostępu do sieci.

Samo budowanie bez compose (te same argumenty):

```
set -a; . docker/versions.env; set +a
GIT_SHA=$(git rev-parse HEAD)
docker build -f docker/web-supervised.Dockerfile \
  --build-arg BUN_VERSION --build-arg BUN_ALPINE_DIGEST \
  --build-arg ALPINE_VERSION --build-arg ALPINE_DIGEST \
  --build-arg NEXT_PUBLIC_KRATOS_PUBLIC_URL=https://orto.lotar122.dev/kratos \
  --build-arg GIT_SHA="$GIT_SHA" \
  -t "projecto-web:$GIT_SHA" .
```

- `NEXT_PUBLIC_KRATOS_PUBLIC_URL` jest wkompilowany w bundle, więc musi być podany przy budowaniu (patrz tabela zmiennych).
- Serwer web i worker działają na tym samym Bunie (`BUN_VERSION`): dekoder w workerze i w web to ten sam kod `createDecompressStream` na `node:zlib`.
- Obraz działa jako użytkownik `10001`, nie zawiera plików `.env`, a `.dockerignore` w korzeniu repozytorium wyklucza `.env*`, `.git`, `node_modules`, `archiver-recovery`, `graphify-out`, `.claude` i `phases-bugfix`.
- Skrót obrazu bazowego odświeżasz zapytaniem do rejestru (nagłówek `Docker-Content-Digest`), a zmianę tagu i skrótu wprowadzasz razem, w osobnym commicie:

```
T=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:oven/bun:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -sI -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/oven/bun/manifests/1.4.4-alpine | grep -i docker-content-digest
```

## Zmienne środowiskowe workera

Sekrety trafiają do pliku `.env.web` (`env_file` w `docker-compose.yml`), poza repozytorium i poza obrazem. Worker dziedziczy środowisko serwera web, więc `DB_URL` i `MINIO_*` ustawiasz raz.

| Zmienna | Wymagana | Opis |
| --- | --- | --- |
| `DB_URL` | tak | Adres Postgresa. Najlepiej dedykowana rola: `SELECT, UPDATE(archived_at)` na `orders` i pełny dostęp do tabel `archive_*`. |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | tak | Dostęp do MinIO. Najlepiej dedykowany klucz ograniczony do koszyka z plikami zleceń. Worker bez którejś z tych zmiennych nie startuje. |
| `MINIO_CA_FILE` | nie | Ścieżka do pliku PEM z CA do weryfikacji TLS MinIO, jak w serwerze web. Nie łącz z `MINIO_TLS_INSECURE`. |
| `MINIO_TLS_INSECURE` | nie | `1` lub `true` wyłącza weryfikację TLS MinIO. Niezalecane. Nie łącz z `MINIO_CA_FILE`. Ostrzeżenie i odrzucenie obu naraz następują przy pierwszym użyciu MinIO, tylko dla `https://`. |
| `COMPRESSOR_MEMORY_BUDGET_MIB` | nie | Budżet pamięci programu `projecto-compress`, 64 do 7168, domyślnie `6144`. Nie ustawiaj go powyżej `mem_limit` minus 1024 MiB. Zła wartość zatrzymuje start. |
| `COMPRESSOR_TIMEOUT_MS` | nie | Limit czasu jednego uruchomienia kodeka, domyślnie `10800000` (3 godziny). |
| `PROJECTO_ZSTD_THREADS` | nie | Liczba wątków kompresji zstd (`projecto-compress --threads`), 0 do 64, domyślnie `4`; `0` i `1` to jeden wątek. Brotli zawsze działa na jednym wątku. Program sam zmniejsza liczbę wątków, gdy plik ma mniej zadań (po 0,5 do 8 MiB) niż wątków albo gdy budżet `COMPRESSOR_MEMORY_BUDGET_MIB` nie mieści tylu wątków, aż do jednego wątku; budżetu nigdy nie przekracza. 4 wątki zużywają ok. 4 razy więcej pamięci niż jeden (w granicach budżetu) i w pomiarach przyspieszały kompresję plików 10 do 64 MiB ok. 1,4 do 1,7 raza, nie 4 razy. Ustaw nie więcej niż `cpus` kontenera; przy `cpus: "1.0"` ustaw `1`. Zła wartość zatrzymuje start. |
| `ARCHIVER_LIVENESS_FILE` | nie | Bezwzględna ścieżka pliku, który worker nadpisuje po każdym udanym heartbeacie do bazy (co 10 s); `HEALTHCHECK` sprawdza jego czas modyfikacji. Obraz ustawia `/work/run/archiver-alive`. Ścieżka względna zatrzymuje start workera; bez zmiennej worker nie zapisuje pliku, a `HEALTHCHECK` kończy się niepowodzeniem. |
| `ARCHIVER_LIVENESS_MAX_AGE_MS` | nie | Czyta ją tylko `HEALTHCHECK`: jak stary może być plik z `ARCHIVER_LIVENESS_FILE`, żeby kontener był zdrowy. Dodatnia liczba całkowita ms, domyślnie `60000`. |
| `ARCHIVER_STOP_GRACE_MS` | nie | Po `SIGTERM` worker kończy się sam po tej wartości pomniejszonej o `min(10 s, jedna dziesiąta)`, domyślnie po 90 s (wartość domyślna 100000 ms, jak w trybie `embedded`). Dodatnia liczba całkowita; zła wartość zatrzymuje start. Limit zatrzymania kontenera (`stop_grace_period`) ustaw wyżej, np. `2m`. |
| `DB_POOL_MAX` | nie | Rozmiar puli połączeń, w compose `3`. |
| `ARCHIVER_WORKER_ID` | nie | Nazwa workera w tabeli `archive_workers`, domyślnie `<hostname>:<pid>`. |
| `ARCHIVER_VERSION` | nie | Ustawiana w obrazie na `GIT_SHA`; widać ją w kolumnie `archive_workers.version` razem z wersją `projecto-compress`. |
| `LOG_LEVEL` | nie | Poziom logowania. |

Ustawione w obrazie i zwykle bez zmian: `TMPDIR=/work/tmp`, `ARCHIVER_RECOVERY_DIR=/work/recovery`, `PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress`, `ARCHIVER_LIVENESS_FILE=/work/run/archiver-alive`, `NODE_ENV=production`.

## Wolumeny

| Ścieżka w kontenerze | Wolumen | Uwagi |
| --- | --- | --- |
| `/work/tmp` | `web-work` | Katalog tymczasowy: pobrany oryginał i oba kandydaty (do ok. 750 MiB na plik w obróbce). Musi być wolumenem na dysku, **nie tmpfs** (tmpfs liczy się do limitu pamięci kontenera). Musi przetrwać restart, bo zachowany oryginał jest podstawą dziennika awaryjnego. |
| `/work/recovery` | `web-recovery` | Katalog odzyskiwania (`ARCHIVER_RECOVERY_DIR`), patrz niżej. |

Nazwane wolumeny dziedziczą właściciela (`10001`) z obrazu. Przy katalogach z hosta (bind mount) ustaw właściciela ręcznie: `chown -R 10001:10001 <katalog>`.

## Compose

`docker-compose.yml` w korzeniu repozytorium to jedyny plik compose. Opisane niżej wartości zasobów są w nim ustawione i trzeba je zmieniać razem.

- `mem_limit` kontenera web to budżet kompresora (`COMPRESSOR_MEMORY_BUDGET_MIB`, domyślnie 6144 MiB) plus pamięć Next.js i procesu Bun workera (ok. 350 do 600 MiB) i zapas jądra; nie zmniejszaj go bez obniżenia budżetu. `memswap_limit` równy `mem_limit` wyłącza swap: kontener ma paść szybko, a nie zamulać hosta.
- Z 4 wątkami zstd szczyt rośnie ok. 4 razy względem jednego wątku: ok. 550 MiB dla pliku 8 MiB, 2,8 GiB dla 64 MiB, 4,9 GiB dla 128 MiB; dla plików większych niż 128 MiB (okno 2^28) budżet 6144 MiB mieści już tylko 2 wątki (ok. 4,8 GiB). Program zawsze trzyma się budżetu. Archiwizator kompresuje naraz tylko jeden plik w całym klastrze (zadania biegną pod jedną blokadą doradczą Postgresa, pliki i kodeki po kolei), więc to jest cały szczyt.
- `cpus` i `PROJECTO_ZSTD_THREADS`: ustaw wątki zstd nie wyżej niż `cpus`; przy `cpus: "1.0"` ustaw `1`.
- `pids_limit` musi objąć wątki Buna serwera web oraz do `PROJECTO_ZSTD_THREADS` + 3 wątków kompresora (z domyślnymi 4 wątkami do 7).
- `init: true` (tini jako PID 1) sprząta procesy potomne, a `stop_grace_period: 2m` (przy `docker stop`: `-t 120`) daje workerowi czas na zakończenie zadania jako `interrupted` i zwolnienie blokady. Nie nadpisuj `entrypoint`.
- Wartość `DOWNLOAD_DECODE_BUDGET_MIB` sprawdź względem limitu pamięci kontenera.

## Nadzorca workera i zatrzymywanie

Przy starcie serwer (`src/instrumentation-node.js`) tworzy nadzorowany proces potomny Buna z `worker/archiver/main.js` (`src/app/server-functions/orders/archiverSupervisor.js`). To zwykły proces potomny, a nie Bun FFI: awaria lub OOM kompresora zabija tylko worker, a przerwanie zadania nadal działa (`SIGTERM`, potem `SIGKILL`).

Obraz (i `docker-compose.yml`) ustawia `ARCHIVER_MODE=embedded`, `ARCHIVER_RECOVERY_DIR=/work/recovery`, `ARCHIVER_LIVENESS_FILE=/work/run/archiver-alive`, `PROJECTO_COMPRESSOR_BIN`, `TMPDIR=/work/tmp` (zadeklarowany jako `VOLUME`; w produkcji zamontuj tam nazwany wolumen, żeby oryginały z dziennika awaryjnego przetrwały wymianę kontenera) i działa jako użytkownik `10001`. `HEALTHCHECK` (`docker/web-healthcheck.js`) wymaga odpowiedzi 2xx z `/api/ping` oraz, gdy działa nadzorca (`ARCHIVER_MODE` nieustawiona, pusta lub `embedded`; przy `off` lub innej wartości pomija to sprawdzenie), świeżego pliku z `ARCHIVER_LIVENESS_FILE` (starszego niż `ARCHIVER_LIVENESS_MAX_AGE_MS` nie uznaje); zawieszony lub restartujący się w pętli worker robi więc kontener niezdrowym. Sprawdzenie odpytuje `http://127.0.0.1:$PORT/api/ping` (`PORT`, domyślnie `3000`), więc przekazanie `-p` lub `-H` w argumentach uruchomienia (trafiają do `next start`, np. `-p 8080`, `-H 10.0.0.5`) sprawia, że sprawdza złe miejsce i kontener zostanie uznany za niezdrowy; ustaw wtedy `PORT` zgodnie z faktycznym portem (adres nasłuchu musi obejmować `127.0.0.1`) albo nadpisz `HEALTHCHECK`. Mapowanie portów Dockera (`docker run -p 8080:3000`) niczego nie psuje.

Entrypoint to `/bin/sh -c`, który gdy `ARCHIVER_MODE` jest nieustawiona, pusta lub `embedded` eksportuje `NEXT_MANUAL_SIG_HANDLE=1` i przez `exec` uruchamia `bun --bun node_modules/next/dist/bin/next start`; argumenty uruchomienia trafiają do `next start`, a `-e ARCHIVER_MODE=off` (niewspierane) wyłącza zarówno worker, jak i tę zmienną. Dzięki temu `SIGTERM` i `SIGINT` obsługuje nadzorca (patrz `NEXT_MANUAL_SIG_HANDLE` w tabeli), który kończy proces dopiero po zatrzymaniu workera. Zatrzymuj kontener z limitem wyższym niż `ARCHIVER_STOP_GRACE_MS`, czyli `docker stop -t 120` albo `stop_grace_period: 2m`, i **zawsze uruchamiaj go z initem jako PID 1** (`docker run --init` albo `init: true`; oba używają tini): Bun jako PID 1 nie zbiera osieroconych procesów, więc `projecto-compress` pozostawiony po zabitym przez `SIGKILL` workerze zostałby zombie. Obraz deklaruje jako `VOLUME` wszystkie ścieżki zapisu (`/work/tmp`, `/work/recovery`, `/work/run`, `/app/.next/cache`), więc powinien działać z `read_only: true` przy zamontowanych wolumenach i tmpfs opisanych niżej (nie było to testowane; Bun i Next.js mogą potrzebować dodatkowych zapisywalnych ścieżek, np. `/tmp`). Zalecane: tmpfs z `uid=10001,gid=10001` pod `/work/run` i `/app/.next/cache` (pliki jednorazowe), nazwane wolumeny na dysku pod `/work/tmp` i `/work/recovery`, a `tmpfs: /tmp` dla Buna. Bez montowania zapis trafia do anonimowych wolumenów. Przy `docker run` bez `--rm` (i po `docker rm` bez `-v`) zostają one na hoście po usunięciu kontenera; `/work/tmp` może zawierać wiele GiB (pobrane oryginały i kandydaci), więc sprzątaj je (`docker volume ls -f dangling=true`, `docker volume prune`) albo uruchamiaj z `--rm`. Zmiana `entrypoint` w compose nadpisuje opisane zachowanie; zostaw domyślny.

## Kolejność wdrożenia

Obraz web ze zmienionym dekoderem (`createDecompressStream`: okno zstd 28 i brotli large-window) musi trafić na serwer **przed** pierwszym uruchomieniem workera. Stary obraz web nie pobierze pliku, który worker skompresował z oknem 28 lub w trybie large-window.

1. **R0**: wydanie samego web z nowym dekoderem. Nadal kompresuje w procesie, starymi ustawieniami; jego wynik dekoduje się bez problemu.
2. Migracje bazy (sekcje "Migracja zadań archiwizacji" i "Migracja znacznika usuwania zleceń"). Są addytywne, stary kod ignoruje nowe tabele i kolumnę. Plik `2026-11-20_orders_deleting_at.sql` musi być wykonany przed wdrożeniem nowego kodu.
3. Uruchom nowy obraz web (`docker compose up -d --build`): wbudowany worker czeka na zadania i wysyła heartbeat.
4. Skopiuj istniejące pliki z katalogu odzyskiwania dotychczasowego kontenera web do wolumenu `web-recovery` (patrz niżej). Nie usuwaj oryginałów.
5. Wdróż web z nowymi trasami kolejki (ten sam obraz). Jeśli stary proces web wykonuje w tej chwili zadanie, nadal trzyma blokadę (`ARCHIVE_LOCK_KEY`), więc worker poczeka, aż ono się skończy.
6. Sprawdź rewizję uruchomionych obrazów (patrz niżej).

## Katalog odzyskiwania (przeniesienie)

Do tej pory `ARCHIVER_RECOVERY_DIR` był katalogiem kontenera web; teraz używa go worker (`/work/recovery`). Skopiuj dotychczasowe pliki `<id>.orig` i `<id>.json` do wolumenu `web-recovery`, a oryginały zostaw na miejscu:

```
# kopia z kontenera web na hosta
docker cp <kontener-web>:<ARCHIVER_RECOVERY_DIR>/. ./archiver-recovery-copy

# z hosta do wolumenu (ten sam obraz web, jako root tylko na czas kopiowania)
docker run --rm --user 0 --entrypoint sh \
  -v "$PWD/archiver-recovery-copy:/from:ro" -v projecto_web-recovery:/to \
  "projecto-web:$GIT_SHA" -c 'cp -a /from/. /to/ && chown -R 10001:10001 /to'
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
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <kontener-web>
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "projecto-web:$GIT_SHA"
```

Wszystkie trzy wartości muszą być równe. Ten sam skrót widać w bazie: `SELECT worker_id, version, heartbeat_at FROM archive_workers;` (kolumna `version` ma postać `<skrót> / projecto-compress 1.0.0 zstd 1.5.7 brotli 1.2.1`).

Sprawdzenia samego obrazu:

```
docker run --rm --entrypoint id "projecto-web:$GIT_SHA"           # uid=10001
docker run --rm --entrypoint projecto-compress "projecto-web:$GIT_SHA" --version
docker run --rm --entrypoint sh "projecto-web:$GIT_SHA" -c 'ls -a /app'   # bez plików .env
```

## Wycofanie zmian

1. Zanim cokolwiek wycofasz, rozstrzygnij wpisy `archive_pending_verify`: uruchom workera jeszcze raz (dokończy przerwane sprawdzenia i w razie potrzeby przywróci oryginał) albo sprawdź wiersze ręcznie.
2. Wdróż poprzedni obraz web, ale **nigdy starszy niż R0**. Od chwili, gdy worker zarchiwizował pierwszy plik, obiekty w koszyku mogą mieć okno zstd 28 lub brotli large-window, a obrazy starsze niż R0 ich nie pobiorą.
3. Zatrzymaj web (worker jest jego częścią). Tabele `archive_*` są nieszkodliwe i można je zostawić; usunięcie opisuje komentarz `rollback` w pliku SQL migracji.

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
