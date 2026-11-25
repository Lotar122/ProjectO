import { OPERATOR } from "./operator";

// Single source for the legal pages and for docs/legal/01 and 02 (generated from this file).
// Paragraph arrays hold plain text; "list" items render as bullets.

export const PRIVACY = {
	title: "Polityka prywatności",
	intro: [
		"Ta polityka opisuje, jak serwis ProjectO przetwarza dane osobowe. ProjectO to system, w którym gabinety i kliniki ortodontyczne przekazują pracowni zlecenia wraz z plikami (skanami, opisami).",
	],
	sections: [
		{
			heading: "1. Kto przetwarza dane",
			paras: [
				`Operatorem serwisu jest ${OPERATOR.name}, ${OPERATOR.address}, NIP ${OPERATOR.taxId} (dalej: Operator). Kontakt w sprawach danych osobowych: ${OPERATOR.email}.`,
				"Operator występuje w dwóch rolach, w zależności od rodzaju danych:",
			],
			list: [
				"Dane pacjentów (imię i nazwisko, opis zlecenia, pliki ze skanami): Operator jest podmiotem przetwarzającym, a administratorem jest gabinet lub klinika, która złożyła zlecenie. Operator przetwarza te dane wyłącznie na jej polecenie, na podstawie umowy powierzenia (art. 28 RODO).",
				"Dane kont użytkowników (pracowników gabinetów i klinik): Operator jest administratorem.",
			],
		},
		{
			heading: "2. Jakie dane przetwarzamy",
			list: [
				"Dane konta: adres e-mail, imię, nazwisko, hasło (przechowywane wyłącznie w postaci skrótu) oraz identyfikator konta.",
				"Dane zleceń wprowadzane przez gabinet: imię i nazwisko pacjenta, opis zlecenia, termin wykonania, nazwa zleceniodawcy, pliki dołączone do zlecenia (w tym skany jamy ustnej). Są to dane dotyczące zdrowia (art. 9 RODO).",
				"Dane techniczne: serwer aplikacji zapisuje w dziennikach metodę, ścieżkę i status żądania oraz czas jego obsługi, a także identyfikatory kont i zleceń. Serwer pośredniczący (reverse proxy) zapisuje ponadto adresy IP i dane żądań. Imiona pacjentów, adresy e-mail ani hasła nie trafiają do dzienników aplikacji.",
				"Plik cookie sesji i zabezpieczeń, opisane w polityce cookies.",
			],
		},
		{
			heading: "3. Cel i podstawa prawna",
			list: [
				"Konta użytkowników: utworzenie konta, logowanie i obsługa serwisu. Podstawą jest prawnie uzasadniony interes Operatora polegający na świadczeniu usługi gabinetowi, który korzysta z serwisu (art. 6 ust. 1 lit. f RODO).",
				"Bezpieczeństwo i diagnostyka (dzienniki techniczne, w tym adresy IP): ochrona serwisu, wykrywanie nadużyć i błędów, na podstawie prawnie uzasadnionego interesu (art. 6 ust. 1 lit. f RODO).",
				"Dane pacjentów: realizacja zlecenia na polecenie gabinetu. Podstawę prawną przetwarzania ustala gabinet jako administrator.",
			],
			paras: [
				"Operator nie wykorzystuje danych do własnych celów. Nie prowadzi marketingu, profilowania ani analityki, nie sprzedaje i nie udostępnia danych w celach innych niż świadczenie usługi.",
			],
		},
		{
			heading: "4. Odbiorcy danych",
			paras: [
				"Dane są przechowywane na serwerach należących do Operatora i nie korzystamy z zewnętrznych dostawców hostingu. Dane nie są nikomu ujawniane, chyba że obowiązek przekazania wynika z przepisów prawa.",
				"Serwery znajdują się w Polsce. Dane nie są przekazywane poza Europejski Obszar Gospodarczy.",
			],
		},
		{
			heading: "5. Jak długo przechowujemy dane",
			paras: [
				"Dane przechowujemy przez czas korzystania z serwisu przez gabinet. Usuwamy je na wniosek, wysłany na adres e-mail podany w punkcie 1. Wniosek może złożyć gabinet (administrator danych pacjentów) lub użytkownik w sprawie swojego konta. Dane usuwamy bez zbędnej zwłoki, nie później niż w ciągu 14 dni od potwierdzenia wniosku. Nie wykonujemy kopii zapasowych, więc po usunięciu danych nie pozostają ich inne kopie.",
				"Dzienniki techniczne, w tym adresy IP, przechowujemy przez 30 dni, po czym są usuwane.",
			],
		},
		{
			heading: "6. Prawa osób, których dane dotyczą",
			paras: [
				"Przysługuje Ci prawo dostępu do danych, sprostowania, usunięcia, ograniczenia przetwarzania, przenoszenia danych oraz sprzeciwu wobec przetwarzania opartego na prawnie uzasadnionym interesie. Aby z nich skorzystać, napisz na adres e-mail z punktu 1.",
				"Jeżeli jesteś pacjentem, Operator przetwarza Twoje dane na polecenie gabinetu. Wniosek skieruj do gabinetu, który jest administratorem Twoich danych. Jeśli trafi do Operatora, przekaże go gabinetowi.",
				"Masz prawo wnieść skargę do Prezesa Urzędu Ochrony Danych Osobowych (ul. Stawki 2, 00-193 Warszawa).",
			],
		},
		{
			heading: "7. Bezpieczeństwo",
			paras: [
				"Dostęp do serwisu wymaga logowania. Połączenie jest szyfrowane (HTTPS), dane na dyskach serwera są szyfrowane, a konta pracowników gabinetów widzą tylko zlecenia własnego konta. Dostęp administracyjny mają wyłącznie upoważnione osoby zobowiązane do zachowania poufności.",
			],
		},
		{
			heading: "8. Zmiany polityki",
			paras: [
				`Aktualna wersja obowiązuje od ${OPERATOR.updated}. O istotnych zmianach poinformujemy gabinety na adresy e-mail powiązane z kontami.`,
			],
		},
	],
};

export const COOKIES = {
	title: "Polityka cookies",
	intro: [
		"Serwis ProjectO używa wyłącznie plików cookie niezbędnych do jego działania. Nie używamy cookies analitycznych, reklamowych ani zewnętrznych skryptów śledzących, dlatego nie wyświetlamy okna z prośbą o zgodę.",
	],
	sections: [
		{
			heading: "1. Z jakich cookies korzystamy",
			table: {
				head: ["Nazwa", "Cel", "Ważność"],
				rows: [
					["ory_kratos_session", "Utrzymuje zalogowaną sesję użytkownika.", "Do wylogowania lub wygaśnięcia sesji [UZUPEŁNIJ wg konfiguracji Kratos]"],
					["csrf_token_*", "Chroni formularz logowania przed fałszywymi żądaniami (CSRF).", "Czas trwania sesji przeglądarki [ZWERYFIKUJ]"],
				],
			},
			paras: [
				"Pliki cookie ustawia system uwierzytelniania Ory Kratos działający w ramach serwisu. Nie są przekazywane żadnym stronom trzecim.",
			],
		},
		{
			heading: "2. Podstawa prawna",
			paras: [
				"Cookies niezbędne do świadczenia usługi, o którą prosi użytkownik (zalogowanie się), nie wymagają zgody na podstawie przepisów Prawa komunikacji elektronicznej. Dane z nich nie są wykorzystywane do innych celów.",
			],
		},
		{
			heading: "3. Pamięć przeglądarki",
			paras: [
				"Serwis nie zapisuje danych w pamięci lokalnej przeglądarki (localStorage, sessionStorage). Czcionki są częścią serwisu i nie są pobierane z serwerów zewnętrznych.",
			],
		},
		{
			heading: "4. Jak usunąć lub zablokować cookies",
			paras: [
				"Możesz usunąć lub zablokować pliki cookie w ustawieniach przeglądarki. Zablokowanie cookies sesji uniemożliwi zalogowanie się do serwisu.",
			],
		},
		{
			heading: "5. Kontakt",
			paras: [
				`Pytania dotyczące cookies i danych osobowych: ${OPERATOR.email}. Szczegóły przetwarzania danych opisuje Polityka prywatności.`,
			],
		},
	],
};
