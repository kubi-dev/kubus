# Plan naprawy mikrofonu systemowego na iOS (do zakodowania)

Stan na 2026-09-11. Wynik przeglądu kodu WebKit (main + snapshot z ery iOS 26), zgłoszeń innych
developerów i audytu naszego kodu (workflow `ios-speech-system-fix`, run `wf_7b322dc8-d36`,
transkrypty w `~/.claude/projects/-Users-piotrmisiurek-kubus/9d0f35d7-1739-486d-a248-e26f9666868a/subagents/workflows/wf_7b322dc8-d36/`).

## Przyczyna (wysoka pewność)

1. Na iOS (Safari i Chrome = WKWebView) mikrofon dla `SpeechRecognition` jest przechwytywany
   w procesie GPU przez współdzieloną jednostkę audio (`CoreAudioCaptureUnit::defaultSingleton()`),
   a samo rozpoznawanie (`SFSpeechRecognizer`, wymuszone na urządzeniu) działa w procesie UI.
2. Kategoria sesji audio jest ustawiana w dwóch niezależnych miejscach: proces GPU przy starcie
   jednostki (`PlayAndRecord`/`VideoChat`) i proces WebContent (`MediaSessionManagerCocoa::updateSessionState`)
   na podstawie tego, co gra na stronie. Element `<audio>` ustawia `MediaPlayback`, a po zakończeniu
   odtwarzania WebContent **dezaktywuje sesję**.
3. Ścieżka SpeechRecognition **nigdy nie sprząta źródła przechwytywania** w procesie GPU
   (`SpeechRecognitionRealtimeMediaSourceManager` woła tylko `stop()`, nigdy `end()`), więc jednostka
   audio zostaje "uruchomiona". Przy następnej sesji `continueStartProducingData()` wychodzi od razu
   (`isProducingData()` true) i **nie ustawia ponownie kategorii ani nie aktywuje sesji**. Jeśli w
   międzyczasie `<audio>` przełączyło kategorię na `MediaPlayback` i zdezaktywowało sesję, jednostka
   nie dostaje próbek: rozpoznawanie dostaje ciszę, po ~6 s "No speech detected".
4. To bug WebKit 317741 (inżynier Apple youennf: "AudioSession being deactivated while speech
   recognition is running"), naprawiony w WebKit 315887@main (26.06.2026). Bug 321436 (10.08.2026,
   iOS 26.6) pokazuje, że iOS 26.x nadal go ma. Poprawka najwcześniej w iOS 27.
5. `onstart` i `onaudiostart` przychodzą **zawsze natychmiast**, niezależnie od tego, czy mikrofon
   daje próbki. Nie są dowodem na nic.
6. Przeładowanie strony nie pomaga: jednostka audio żyje w procesie GPU, wspólnym dla wszystkich stron.
   Pomaga dopiero zabicie przeglądarki.
7. Nasza poprzednia próba "getUserMedia trzymane w trakcie nasłuchu" była w złej kolejności:
   strumień getUserMedia otwarty **przed** `recognition.start()` daje głuche sesje (5/5 w teście
   guchi-apps/aide-bot PR #211 na iPhonie), otwarty **po** `start()` działa (3/3).

## Obejście potwierdzone na iPhone'ach przez innych

Źródła: WebAudio/web-speech-api issue #96 (użytkownik zollillo, iOS 18.7.3 i 26.2, ten sam
scenariusz: mp3 TTS + SpeechRecognition), guchi-apps/aide-bot PR #211 (09.2026, sprawdzone na
urządzeniu), golubintsev-source/orders-site PR #18 (07.2026).

**Zasada: strona nie może nigdy pozwolić WebContent na dezaktywację sesji audio.**

1. **Odtwarzanie mp3 przez Web Audio, nie przez `<audio>`.**
   Jeden `AudioContext` na stronę, utworzony i `resume()` w pierwszym geście użytkownika,
   nigdy nie zamykany. Odtwarzanie: `fetch(mp3) -> decodeAudioData -> AudioBufferSourceNode -> destination`.
   Bufory cache'ować per plik. Kontekst żyje cały czas, więc sesja nie jest dezaktywowana po końcu dźwięku.
   Wolniej: `source.playbackRate = 0.6` na normalnym pliku albo osobny bufor z pliku `-slow.mp3`.
2. **`recognition.start()` "goły"**: bez getUserMedia przed startem, bez `navigator.audioSession`,
   bez timerów. Nowa instancja `SpeechRecognition` na sesję jest OK (i tak każdy start tworzy nowy
   rozpoznawacz po stronie WebKit); singleton nic nie daje.
3. **Opcjonalnie, dopiero po `onstart`:** `getUserMedia({audio:true})`, strumień trzymany do `onend`,
   potem `track.stop()`. Ustawia w WebContent kategorię `PlayAndRecord`/`VideoChat` na czas nasłuchu
   (SpeechRecognition sam tego w WebContent nie robi). Tryb `VideoChat` kieruje dźwięk na głośnik, więc
   odtwarzanie po nasłuchu nie jest ciche. Jeśli po wdrożeniu punktów 1-2 mikrofon działa, punkt 3 pominąć.
4. **Nie ruszać `navigator.audioSession.type`.** `play-and-record` na stałe = dźwięk do słuchawki
   (ciche mp3), `auto` po nim = możliwy tryb `ambient`, który respektuje przełącznik wyciszenia (brak dźwięku).
5. Wyrzucić: tryb "system + przeładowanie", odliczanie 3,5 s po audio, getUserMedia przed startem,
   `releaseAudio()` z `removeAttribute("src")`/`load()` (nie będzie już elementu `<audio>`).

Ryzyko do sprawdzenia na telefonie: Web Audio bez `<audio>` może dostać kategorię `ambient`
**przed pierwszym użyciem mikrofonu**, czyli przy włączonym przełączniku wyciszenia pierwsze mp3
może być ciche. Po pierwszym nasłuchu jednostka GPU trzyma `PlayAndRecord` i problem znika.
Jeśli to przeszkadza: przy pierwszym geście wykonać krótkie `getUserMedia` open/close (rozgrzewka),
co przełącza sesję na `PlayAndRecord`/`VideoChat`.

## Błędy w naszym kodzie do naprawienia przy okazji (audyt `wymowa.js`, `template.html`, `powtorka.html`)

1. `wymowa.js`: watchdog 15 s nic nie robi, gdy stan to `starting` (`rec.start()` wywołane, `onstart`
   nie przyszło). Stan zostaje nie-`idle` na zawsze, każde kolejne naciśnięcie tylko ląduje w `pending`
   i etykieta przycisku się nie zmienia. **To jest "przycisk w ogóle nie reaguje".**
   Fix: watchdog niezależny od stanu; po jego upływie `abort()`, a po kolejnych 3 s wymuszone `finish`.
2. `wymowa.js` `onstart` z `released=true`: ustawia `stopping` i `abort()` bez żadnego limitu czasu.
   Fix: ten sam mechanizm `endGuard` co po `stop()`.
3. `wymowa.js` wymuszone zakończenie robi `rec = null`, ale handlery starej instancji dalej piszą do
   globali (`state`, `session`, `micStream`). Spóźnione `onend` starej instancji ubija nową sesję.
   Fix: handlery sprawdzają `if (this !== rec) return;` (albo instancja per sesja z własnym obiektem stanu).
4. `template.html:134` `audio.play().catch(() => speakSystem(text))`: gdy `releaseAudio()` pauzuje mp3,
   którego `play()` jeszcze nie ruszył, `catch` odpala głos systemowy (Apple TTS) w trakcie nasłuchu i
   pokazuje "Nagranie niedostępne". Fix: ignorować `AbortError`; przy Web Audio problem znika.
5. `pending` nigdy nie jest czyszczone, gdy karta/element zniknie; drobne.

## Plan testu na telefonie (po wdrożeniu)

1. Zabić Chrome (przesunąć z listy aplikacji), otworzyć stronę na nowo.
2. Lekcja: kliknij kartę (mp3), od razu przytrzymaj mikrofon, powiedz słowo. Oczekiwane: "słyszę:" na żywo.
3. Powtórz na 5 kartach pod rząd, z odtwarzaniem między nimi. Oczekiwane: działa za każdym razem.
4. Powtórka: karta B (auto mp3) → opcja → 🐢 wolniej → mikrofon w odsłonięciu. Oczekiwane: działa.
5. Sprawdzić głośność mp3 po użyciu mikrofonu (ma być z głośnika, normalna) i z przełącznikiem
   wyciszenia włączonym (pierwsze mp3 przed użyciem mikrofonu może być ciche, patrz ryzyko).
6. Screenshot diagnostyki po każdej nieudanej próbie.

## Jeśli nie zadziała

Zostaje chmura z lepszym modelem mandaryńskiego niż whisper-turbo (Azure Speech F0 z oceną wymowy,
Groq whisper-large-v3, Alibaba Qwen3-ASR), nagranie przez getUserMedia działa na iOS zawsze.
