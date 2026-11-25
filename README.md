# SpeedPL

Uczciwy, polskojęzyczny test prędkości internetu zbudowany w Node.js + Express.

## Funkcje

- Prawdziwe, wielostrumieniowe pomiary pobierania i wysyłania (1–6 równoległych strumieni).
- Ping (z rozgrzewką TCP/TLS), min/max/P95, strata prób, jitter i latencja pod obciążeniem (osobno dla pobierania i wysyłania / bufferbloat).
- Wykresy prędkości pobierania i wysyłania na żywo (Chart.js).
- Natychmiastowe zatrzymanie testu (`AbortController` + `XMLHttpRequest.abort()`).
- Wybór serwera testowego.
- Analiza jakości połączenia przez Groq AI z wyborem trybu (`Ogólna ocena`, `Gry online`, `Streaming 4K`, `Praca zdalna`), automatycznym modelem zapasowym i kopią Markdown.
- Opcjonalna historia wyników w PostgreSQL lub TiDB/MySQL.
- Responsywny, ciemny interfejs.

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env
# uzupełnij GROQ_API_KEY i opcjonalnie DATABASE_URL
npm start
```

Aplikacja nasłuchuje na `http://localhost:3000` (lub `process.env.PORT`).

## Zmienne środowiskowe

- `PORT` - port HTTP.
- `HOST` - adres nasłuchu.
- `GROQ_API_KEY` - klucz API Groq (tylko backend).
- `GROQ_MODEL` - domyślnie `openai/gpt-oss-20b`.
- `GROQ_FALLBACK_MODEL` - zapasowy model Groq używany przy błędzie modelu głównego lub limicie zapytań (domyślnie `llama-3.1-8b-instant`).
- `GROQ_API_URL` - domyślnie `https://api.groq.com/openai/v1/chat/completions`.
- `DATABASE_URL` - opcjonalny PostgreSQL. Dla TiDB/MySQL ustaw `MYSQL_URL` lub `TIDB_DATABASE_URL` (albo `DATABASE_URL=mysql://...`) i zainstaluj opcjonalnie `mysql2` (poza pięcioma wymaganymi zależnościami).
- `SPEEDPL_SERVERS` - opcjonalna lista węzłów JSON: `[{"id":"warsaw","name":"Warszawa","url":"https://..."}]`.
- `SERVER_NAME` - nazwa bieżącego serwera.

## Serwery testowe

Aplikacja nie tworzy fikcyjnych adresów IP. Domyślnie dostępny jest tylko bieżący serwer. Dodatkowe węzły (np. Warszawa, Kraków, Gdańsk, Wrocław, Poznań) można dodać przez `SPEEDPL_SERVERS`, wskazując realne adresy URL działających instancji SpeedPL. W interfejsie nieskonfigurowane miasta są widoczne jako wyłączone.

## Render

1. Utwórz usługę Web Service.
2. Ustaw Build Command: `npm install`.
3. Ustaw Start Command: `npm start`.
4. Dodaj zmienne środowiskowe.
5. Opcjonalnie dodaj PostgreSQL i ustaw `DATABASE_URL`.

## Uwagi o uczciwości pomiarów

- Pobieranie używa strumienia losowych bajtów z serwera.
- Wysyłanie mierzy rzeczywisty czas przesłania danych.
- Ping i jitter liczone z rzeczywistych RTT.
- Latencja pod obciążeniem mierzona podczas transferu.
- AI analizuje wyniki, ale ich nie zmienia.