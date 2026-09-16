# Pixa Charts

Cotygodniowe notowanie utworów z kanału YouTube **Pixa Roleplay** (w stylu Billboard Hot 100).

## Jak używać

- **Otwórz notowanie:** `index.html` (dwuklik) – zakładki *Top 10 Now* i *Top 100 All Time*.
- **Odśwież ręcznie:** `update.cmd` (ok. 40 s). Log z ostatniego uruchomienia: `logs\last-run.log`.
- **Automatycznie:** zadanie „PixaCharts Weekly” w Harmonogramie zadań Windows uruchamia `update.cmd`
  co poniedziałek o 9:00 (jeśli komputer był wyłączony – przy najbliższym włączeniu).

## Zasady notowań

- **Top 10 Now** – utwory wydane od „Tiny Shuj - Nowy cali G” włącznie (wszystko nowsze na kanale), posortowane po wyświetleniach.
- **Top 100 All Time** – wszystkie filmy z kanału oprócz tych z „PIXA” w tytule, posortowane po wyświetleniach.
- Wyświetlenia są dokładne (pobierane per film), nie zaokrąglone jak na liście kanału.
- Każde uruchomienie zapisuje migawkę w `history.json`; na jej podstawie liczone są strzałki ▲▼, NEW, „szczyt” i „tyg. w notowaniu”.
  Ponowne uruchomienie tego samego dnia nadpisuje migawkę z tego dnia (nie tworzy sztucznego „tygodnia”).

## Konfiguracja (`config.json`)

| Klucz | Znaczenie |
|---|---|
| `channelUrl` | adres kanału |
| `nowStartVideoId` | ID filmu, od którego liczy się „Top 10 Now” (`_yAfcKGcz7Y` = Nowy cali G) |
| `nowSize` / `allTimeSize` | rozmiar notowań (10 / 100) |
| `excludeKeyword` | słowo wykluczające z notowań (`PIXA`) |
| `excludeCaseSensitive` | `true` = tylko wielkie „PIXA”; `false` = także „Pixa”, „pixa” |
| `applyExcludeToNow` | czy wykluczenie dotyczy też „Top 10 Now” (domyślnie `true`) |

## Pliki

- `update.mjs` – skrypt pobierający dane (Node.js + `youtubei.js`, bez klucza API)
- `template.html` – szablon strony; `index.html` – wygenerowana strona z osadzonymi danymi
- `data.json` – dane bieżącego notowania; `history.json` – historia migawek

Jeśli YouTube zmieni stronę i skrypt przestanie działać: `npm update youtubei.js`.


