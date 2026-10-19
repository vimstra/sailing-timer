# sailing-timer

PWA z timerem sekwencji startowych w regatach. Czysty HTML/CSS/JS, bez kroku budowania. Pliki aplikacji są w `public/`.

## Jak działa

1. Klasy i kolejność startów (opcjonalny odstęp między startem jednej klasy a ostrzeżeniem następnej).
2. Czasy sekwencji – domyślnie regaty floty 5-4-1-0.
3. Flaga przygotowania (P, I, Z, U, czarna) – wspólna lub osobna dla każdej klasy.
4. Czas od flagi pomarańczowej do sygnału ostrzeżenia.
5. Ekran startu – opcja „Zacznij od flagi pomarańczowej”.

Na timerze duży licznik odlicza do najbliższego zdarzenia, mniejszy – do startu bieżącej klasy.

Dźwięki: 1 piknięcie 30 s przed zdarzeniem, pojedyncze od 10 do 6 s, podwójne od 5 do 1 s, długie na sygnał.

Trwająca sekwencja zapisuje się w `localStorage`, więc po przeładowaniu lub zamknięciu aplikacji timer wraca do właściwego miejsca. Ekran nie gaśnie (Screen Wake Lock).

## Lokalnie

```bash
npm install
npm run dev
```

Albo bez Node: `python3 -m http.server 8787 --directory public`.

## Wdrożenie na Cloudflare (Workers, statyczne pliki)

Repo jest podpięte w Cloudflare (Workers & Pages → Worker połączony z GitHubem). Każdy push na `main` uruchamia `npx wrangler deploy`, który wgrywa katalog `public/` (sekcja `[assets]` w `wrangler.toml`). Nazwa Workera w panelu musi być taka sama jak `name` w `wrangler.toml`.

Ręcznie z konsoli:

```bash
npx wrangler login
npm run deploy
```

Po każdej zmianie plików podbij `CACHE` w `public/sw.js`, żeby zainstalowane aplikacje pobrały nową wersję.

## Uwagi dla iPhone'a

- Dźwięk włącza się przyciskiem Start (wymóg przeglądarki). Po przeładowaniu w trakcie sekwencji trzeba dotknąć ekranu.
- Po zablokowaniu ekranu lub przejściu do innej aplikacji iOS wstrzymuje dźwięk – timer liczy dalej, ale piknięcia wrócą dopiero po powrocie do aplikacji.
