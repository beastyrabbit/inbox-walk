// Fixed wording is copied from the shared rollout templates; keep both languages aligned.
export const LEGAL_DATE = { de: '21. Oktober 2026', en: 'October 21, 2026' } as const

export type LegalLanguage = 'de' | 'en'
export type LegalSection = { heading: string; body: string }
export type LegalDocument = {
  title: string
  intro: string
  numbered: boolean
  sections: LegalSection[]
}

export const legalNotices: Record<LegalLanguage, LegalDocument> = {
  de: {
    title: `Impressum`,
    intro: ``,
    numbered: false,
    sections: [
      {
        heading: `Anbieter`,
        body: `Tobias Heer
c/o Impressumservice Dein-Impressum
Stettiner Str. 41
35410 Hungen
Deutschland`,
      },
      {
        heading: `Kontakt`,
        body: `E-Mail: [impressum-inbox-walk@heerlab.com](mailto:impressum-inbox-walk@heerlab.com)
Kontaktformular: [beastyrabbit.com/kontakt](https://beastyrabbit.com/kontakt?from=inbox-walk)`,
      },
      {
        heading: `Hinweis`,
        body: `Inbox Walk ist ein privates, nicht-kommerzielles Projekt.`,
      },
      {
        heading: `Datenschutz`,
        body: `Informationen zur Verarbeitung personenbezogener Daten finden Sie in der [Datenschutzerklärung](/datenschutz).`,
      },
    ],
  },
  en: {
    title: `Legal Notice (Impressum)`,
    intro: ``,
    numbered: false,
    sections: [
      {
        heading: `Provider`,
        body: `Tobias Heer
c/o Impressumservice Dein-Impressum
Stettiner Str. 41
35410 Hungen
Germany`,
      },
      {
        heading: `Contact`,
        body: `E-mail: [impressum-inbox-walk@heerlab.com](mailto:impressum-inbox-walk@heerlab.com)
Contact form: [beastyrabbit.com/kontakt](https://beastyrabbit.com/kontakt?from=inbox-walk)`,
      },
      {
        heading: `Note`,
        body: `Inbox Walk is a private, non-commercial project.`,
      },
      {
        heading: `Privacy`,
        body: `For information on how personal data is processed, see the [Privacy Policy](/privacy).`,
      },
    ],
  },
}

export const privacyPolicies: Record<LegalLanguage, LegalDocument> = {
  de: {
    title: `Datenschutzerklärung`,
    intro: `Stand: ${LEGAL_DATE.de}`,
    numbered: true,
    sections: [
      {
        heading: `Verantwortlicher`,
        body: `Verantwortlich für die Verarbeitung personenbezogener Daten auf https://inbox-walk.heerlab.com ist:

Tobias Heer
c/o Impressumservice Dein-Impressum
Stettiner Str. 41
35410 Hungen
Deutschland

E-Mail: [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com)

Ein Datenschutzbeauftragter ist nicht bestellt, da hierzu keine gesetzliche Pflicht besteht.`,
      },
      {
        heading: `Überblick`,
        body: `Diese Erklärung informiert darüber, welche personenbezogenen Daten bei der Nutzung von Inbox Walk verarbeitet werden, zu welchen Zwecken, auf welcher Rechtsgrundlage und wie lange. Inbox Walk ist ein privates, nicht-kommerzielles Projekt. Mit Inbox Walk sortiert der Verantwortliche ungelesene E-Mails aus seinem eigenen Fastmail-Postfach mithilfe eines KI-Modells in Aufgaben, arbeitet sie ab und bereitet Antwortentwürfe vor; die Anwendung versendet selbst keine E-Mails. Verarbeitet werden dabei auch personenbezogene Daten von Personen, die dem Verantwortlichen schreiben oder in E-Mails genannt werden.

Personenbezogene Daten werden nicht verkauft und nicht für Werbung verwendet. Eine automatisierte Entscheidungsfindung einschließlich Profiling im Sinne von Art. 22 DSGVO findet nicht statt.`,
      },
      {
        heading: `Hosting und Bereitstellung`,
        body: `Inbox Walk läuft auf eigener Server-Infrastruktur des Verantwortlichen in Deutschland. Aufrufe aus dem Internet erreichen die Anwendung über einen Reverse-Proxy auf einem virtuellen Server der netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland (Rechenzentrum in Nürnberg). netcup verarbeitet die Daten dabei als Auftragsverarbeiter; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Die Verbindung ist bis zum Reverse-Proxy TLS-verschlüsselt und wird von dort durch einen verschlüsselten Tunnel an die eigene Infrastruktur weitergeleitet.

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in einer sicheren und zuverlässigen Bereitstellung der Website.

Die im Abschnitt „E-Mail-Verarbeitung und gespeicherte Daten“ beschriebenen Anwendungsdaten werden regelmäßig gesichert. Sicherungskopien werden innerhalb der eigenen Infrastruktur in Deutschland gespeichert und nach spätestens drei Monaten überschrieben. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt im Schutz vor Datenverlust.`,
      },
      {
        heading: `Server-Logfiles`,
        body: `Bei jedem Aufruf speichert der Reverse-Proxy automatisch folgende Daten:

- IP-Adresse des anfragenden Geräts
- Datum und Uhrzeit des Zugriffs
- aufgerufene Adresse (Pfad einschließlich Parameter), HTTP-Methode und Protokoll
- HTTP-Statuscode, übertragene Datenmenge und Antwortzeit
- Browser-Kennung (User-Agent)
- verwendete TLS-Version und Verschlüsselung
- angesprochener Dienst

Die Header Cookie und Authorization werden geschwärzt. URL-Pfade und Abfrageparameter werden protokolliert.

Die Daten dienen dem Betrieb, der Fehleranalyse und der Abwehr von Angriffen und Missbrauch. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in Stabilität und Sicherheit des Angebots. Die Logfiles werden nach 14 Tagen automatisch gelöscht.

Pangolin, der Reverse-Proxy, führt zusätzlich ein Anfrageprotokoll (aufgerufene Adresse, Zeitpunkt, IP-Adresse, Ergebnis der Zugriffsprüfung) für 14 Tage, ein Anmeldeprotokoll (Benutzer, Zeitpunkt, IP-Adresse, Ergebnis) für 90 Tage und ein Netzwerkprotokoll für 30 Tage. Die Protokolle dienen dem Betrieb, der Sicherheit und der Zugangskontrolle. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt im sicheren Betrieb und im Schutz des Zugangs.

CrowdSec speichert auf dem Reverse-Proxy lokale Meldungen über erkannte Angriffe (IP-Adresse, Zeitpunkt, Art des Angriffs). Sie werden in der Regel nach sieben Tagen gelöscht; Sperren dauern in der Regel vier Stunden. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt im Schutz vor Angriffen.

Die Anwendung selbst führt kein Zugriffsprotokoll mit IP-Adressen oder Anfrageinhalten. Betriebsmeldungen (Start und Stopp, Anzahl verarbeiteter Nachrichten, Fehlermeldungen) werden nur als kurzlebige Container-Logs auf der eigenen Infrastruktur des Verantwortlichen ausgegeben und nicht zentral gesammelt. Sie werden entfernt, wenn Kubernetes die Logs rotiert oder den Container ersetzt. Fehlermeldungen können technische Angaben wie Dateinamen von Anhängen oder Fehlertexte von Fastmail oder OpenAI enthalten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in Fehleranalyse und Betrieb.`,
      },
      {
        heading: `Schutz vor Angriffen (CrowdSec)`,
        body: `Zum Schutz vor Angriffen wertet die Sicherheitssoftware CrowdSec die Server-Logfiles automatisch aus und sperrt IP-Adressen, von denen erkennbar Angriffe ausgehen (zum Beispiel massenhafte Anmeldeversuche oder das Ausspähen von Schwachstellen). Erkennt CrowdSec einen Angriff, werden die IP-Adresse, der Zeitpunkt und die Art des Angriffs an die CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, Frankreich, übermittelt. CrowdSec nutzt diese Meldungen für eine gemeinsame Sperrliste, die Angriffe auf viele Server abwehrt. Bei normalem Surfen werden keine Daten an CrowdSec übermittelt.

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt im Schutz der Website und ihrer Nutzer vor Angriffen.

Für diese Verarbeitung sind der Verantwortliche und CrowdSec nach Angaben von CrowdSec gemeinsam verantwortlich (Art. 26 DSGVO): CrowdSec ist für den Betrieb seiner zentralen Dienste und Sperrlisten verantwortlich, der Verantwortliche für den Einsatz auf diesem Server. Sie können Ihre Rechte gegenüber beiden geltend machen, bei CrowdSec unter [dpo@crowdsec.net](mailto:dpo@crowdsec.net). CrowdSec kann die gemeldeten Daten an Mitglieder und Partner seines Netzwerks weitergeben. Übermittlungen in Länder außerhalb der EU erfolgen nach Angaben von CrowdSec auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).

Vollständige IP-Adressen werden grundsätzlich höchstens drei Monate gespeichert und anschließend schrittweise verallgemeinert. Für bestimmte Angriffsanalysen und Trainingszwecke nennt CrowdSec Ausnahmen von bis zu einem Jahr vor der Anonymisierung. Details: [crowdsec.net/privacy-policy](https://www.crowdsec.net/privacy-policy).`,
      },
      {
        heading: `Anmeldung (Single Sign-On)`,
        body: `Inbox Walk ist nur für eingeladene Personen zugänglich. Die Anmeldung erfolgt über den Reverse-Proxy Pangolin mit dem selbst betriebenen Identitätsdienst Pocket-ID auf der eigenen Infrastruktur. Dabei werden Benutzername, E-Mail-Adresse, Gruppenzugehörigkeit, Zeitpunkt der Anmeldung und IP-Adresse verarbeitet. Nach der Anmeldung setzt Pangolin ein Sitzungs-Cookie, das für den Zugang technisch erforderlich ist.

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, den Zugang auf berechtigte Personen zu beschränken. Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht. Sicherungskopien werden nach spätestens drei Monaten überschrieben.`,
      },
      {
        heading: `E-Mail-Verarbeitung und gespeicherte Daten`,
        body: `Inbox Walk liest über die Fastmail-Schnittstelle JMAP die ungelesenen eingehenden E-Mails des Verantwortlichen. Für den Sortierkontext kann die Anwendung das gesamte Postfach einschließlich gelesener E-Mails durchsuchen. Verarbeitet werden Namen und Adressen von Absendern und Empfängern, Betreffzeilen, Datumsangaben, Vorschautexte, Nachrichteninhalte, Anhänge sowie Absenderidentitäten und Signaturen des Verantwortlichen.

Änderungen im Postfach erfolgen nur nach einer ausdrücklichen Aktion des Nutzers: Genau die ausgewählten Nachrichten werden als gelesen markiert, mit dem Label „Newsletter abmelden“ versehen oder als Antwortentwurf gespeichert. Inbox Walk versendet keine E-Mails.

In einer SQLite-Datenbank auf der eigenen Infrastruktur in Deutschland werden gespeichert:

- je Nachricht ID, Thread-ID, Betreff, Datum, Namen und Adressen von Absendern und Empfängern, der kurze Vorschautext von Fastmail, Postfachnamen und Bearbeitungsstand;
- vom KI-Modell verfasste Aufgabentitel und Zusammenfassungen;
- die vom Nutzer geschriebene Gedächtnisnotiz und Vorschläge dazu;
- ein Ereignisprotokoll der Sortieraktionen mit IDs und Anzahlen;
- der Zustand des Antworteditors mit Empfängern, Betreff, Entwurfstext und Notizen.

Nachrichteninhalte und Inhalte von Anhängen werden nicht in der Datenbank gespeichert. Sie liegen während der Verarbeitung nur vorübergehend im Arbeitsspeicher des Servers. Dokumentanhänge für Antwortentwürfe wandelt ein Dienst zur Textextraktion (Apache Tika) auf der eigenen Infrastruktur in Text um. Temporäre Dateien werden mit dem temporären Speicher des Containers gelöscht.

Erledigte oder in Fastmail nicht mehr ungelesene Nachrichten werden nach 60 Tagen gelöscht, zusammen mit leeren geschlossenen Aufgabengruppen. Offene oder geparkte Nachrichten und Aufgabengruppen, die noch Nachrichten enthalten, haben keine feste Löschfrist und bleiben bis zur Bearbeitung bestehen. Die Gedächtnisnotiz bleibt, bis der Nutzer sie ändert. Das Ereignisprotokoll enthält die letzten 5.000 Einträge, die Gedächtnisvorschläge die letzten 50. Der Zustand des Antworteditors wird mit seiner Nachricht gelöscht. Die ursprünglichen E-Mails bleiben im Fastmail-Postfach; Inbox Walk löscht sie dort nicht. Zu Sicherungskopien siehe Abschnitt „Hosting und Bereitstellung“.

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in der effizienten Bearbeitung der eigenen E-Mail-Korrespondenz.

Die OpenAI-Anmeldedaten (OAuth-Tokens) werden auf dem Server gespeichert, damit das KI-Modell genutzt werden kann. Sie bleiben gespeichert, bis die Anmeldung entfernt wird.`,
      },
      {
        heading: `Fastmail (E-Mail-Postfach)`,
        body: `Inbox Walk greift wie oben beschrieben auf das Postfach des Verantwortlichen bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, zu. Fastmail verarbeitet das Postfach als Auftragsverarbeiter. Zu Übermittlungen in Drittländer, Standardvertragsklauseln, Datenschutzhinweisen und Löschregeln siehe Abschnitt „Kontakt per E-Mail“.`,
      },
      {
        heading: `KI-Verarbeitung durch OpenAI`,
        body: `Für die Sortierung und Antwortentwürfe nutzt Inbox Walk ein KI-Modell von OpenAI Ireland Ltd, 1st Floor, The Liffey Trust Centre, 117–126 Sheriff Street Upper, Dublin 1, D01 YC43, Irland. Der Zugriff erfolgt über das ChatGPT-Pro-Abonnement des Verantwortlichen über die Codex-Schnittstelle auf chatgpt.com. Die Anmeldung bei OpenAI erfolgt über auth.openai.com.

Für die Sortierung werden Angaben zu neuen Nachrichten (Absender, Empfänger, Betreff, Datum, Vorschautext), bestehende Aufgabentexte und die Gedächtnisnotiz übermittelt. Auf Anforderung des Modells kommen Suchergebnisse und Nachrichtentexte mit bis zu 12.000 Zeichen hinzu. Für Antwortentwürfe werden der vollständige Nachrichtenverlauf mit Adressen, Betreffzeilen, Datumsangaben und Nachrichteninhalten, Bilder aus Anhängen, aus Dokumentanhängen extrahierter Text sowie die Notizen und der Entwurf des Nutzers übermittelt.

Zweck ist die Sortierung von E-Mails und die Vorbereitung von Antwortentwürfen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der effizienten Bearbeitung der eigenen Korrespondenz.

Die Nutzung erfolgt nach den Bedingungen von OpenAI für individuelle ChatGPT-Abonnements. Für diesen Tarif bietet OpenAI keinen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO an und ist daher nicht als Auftragsverarbeiter gebunden. Nach diesen Bedingungen darf OpenAI die Inhalte zur Verbesserung seiner Modelle verwenden, sofern dies nicht in den Kontoeinstellungen deaktiviert wird.

OpenAI verarbeitet Daten auch außerhalb der EU, insbesondere in den USA. Nach Angaben von OpenAI beruhen Übermittlungen auf Angemessenheitsbeschlüssen der Europäischen Kommission oder Standardvertragsklauseln. Inbox Walk fordert bei den Anfragen keine Speicherung an (store: false). Die Aufbewahrung bei OpenAI richtet sich dennoch nach dessen Datenschutzerklärung; eine feste Löschfrist ist nicht zugesichert. Details: [OpenAI-Datenschutzerklärung](https://openai.com/policies/eu-privacy-policy/) und [OpenAI-Nutzungsbedingungen](https://openai.com/policies/eu-terms-of-use/).`,
      },
      {
        heading: `Externe Bilder in E-Mails`,
        body: `Wenn Sie eine Nachricht öffnen, lädt der Inbox-Walk-Server als Proxy die Bilder, die der Absender von externen Servern eingebunden hat. Der Browser lädt diese Bilder nicht direkt. Der externe Server erhält die IP-Adresse des Inbox-Walk-Servers, die Bildadresse (die vom Absender gesetzte Tracking-Kennungen enthalten kann), den Zeitpunkt und eine allgemeine Browser-Kennung. Er erhält weder Ihre IP-Adresse noch Cookies oder E-Mail-Inhalte. Die Bilder werden nicht gespeichert.

Welche Server dies sind, bestimmt der Absender der jeweiligen E-Mail. Deren Standort und Umgang mit Daten liegen außerhalb der Kontrolle des Verantwortlichen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, E-Mails wie vorgesehen darzustellen und dabei Ihre IP-Adresse zu verbergen.`,
      },
      {
        heading: `Nutzungsanalyse (Umami)`,
        body: `Umami wird auf der eigenen Infrastruktur des Verantwortlichen in Deutschland unter umami.heerlab.com betrieben. Es ist kein Drittanbieter beteiligt. Erfasst werden Aufrufe fester virtueller Seiten (etwa Liste, Aufgabengruppe und Einstellungen), Arbeitsablauf-Ereignisse mit Anzahlen und Zeitspannen sowie Leistungsdaten wie Lade- und Antwortzeiten. Hinzu kommen maskierte Sitzungsaufzeichnungen (Replay) und Heatmaps von Klick- und Scrollpositionen mit Seiten- und Fenstergröße.

In Aufzeichnungen sind alle Texte und Eingaben maskiert; E-Mail- und Editorbereiche sind vollständig ausgeschlossen. E-Mail-Inhalte, Betreffzeilen, Adressen, Aufgabentitel, Notizen, Antworttexte und Fastmail-IDs werden nicht übermittelt. Umami verarbeitet die IP-Adresse und Browser-Kennung der Anfrage, um eine Sitzungskennung, Browser, Betriebssystem, Gerätetyp und ungefähren Standort abzuleiten. Umami setzt keine Cookies und speichert keine Daten im Browser.

Zweck ist die Verbesserung von Arbeitsabläufen und Leistung der Anwendung. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in einer gut nutzbaren und schnellen Anwendung. Der Zugriff auf Informationen im Browser beschränkt sich auf das technisch Erforderliche für den vom einzigen Nutzer dieses internen Werkzeugs ausdrücklich gewünschten Dienst (§ 25 Abs. 2 Nr. 2 TDDDG).

Eine automatische Löschung der Analysedaten ist derzeit nicht eingerichtet; sie werden gelöscht, sobald sie für die Auswertung nicht mehr benötigt werden. Zu Sicherungskopien siehe Abschnitt „Hosting und Bereitstellung“.`,
      },
      {
        heading: `Fehlerüberwachung (GlitchTip)`,
        body: `GlitchTip wird auf der eigenen Infrastruktur des Verantwortlichen in Deutschland unter glitchtip.heerlab.com betrieben. Bei Fehlern im Browser oder auf dem Server werden Fehlertyp mit einer allgemeinen Meldung, Codestelle (Datei und Zeile), Version und Umgebung sowie Zeitpunkt übermittelt. Für eine Stichprobe von 10 % der Anfragen werden außerdem die Routenvorlage und Zeitmessungen erfasst.

Fehlermeldungen, Anfrageinhalte, Cookies, Header, E-Mail-Inhalte und Adressen werden vor der Übermittlung entfernt. Die IP-Adresse des sendenden Browsers erreicht den Dienst technisch bedingt. Zweck ist das Erkennen und Beheben von Fehlern. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in einem fehlerfreien Betrieb der Anwendung. Fehlerereignisse und Leistungsdaten werden nach 90 Tagen automatisch gelöscht.`,
      },
      {
        heading: `Kontakt per E-Mail`,
        body: `Wenn Sie per E-Mail Kontakt aufnehmen, werden Ihre E-Mail-Adresse, der Inhalt Ihrer Nachricht und die technischen Angaben der E-Mail verarbeitet, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, Anfragen beantworten zu können.

Die E-Mail-Postfächer werden bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, als Auftragsverarbeiter betrieben. Dabei können Daten in Länder außerhalb der EU übermittelt werden, insbesondere nach Australien, in die USA und nach Indien. Für diese Übermittlungen verwendet Fastmail Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO). Details: [Datenschutzerklärung von Fastmail](https://www.fastmail.com/policies/privacy/), [Auftragsverarbeitungsvertrag](https://www.fastmail.com/policies/dpa/) und [Standardvertragsklauseln](https://www.fastmail.com/policies/dpa/section3/). Eine Kopie der Garantien erhalten Sie auf Anfrage an [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com).

Der Verantwortliche löscht Nachrichten nach Erledigung der Anfrage, soweit keine Aufbewahrung erforderlich ist. Bei Fastmail können anschließend noch Sicherungs- und Protokolldaten nach dessen veröffentlichten Löschregeln verbleiben.`,
      },
      {
        heading: `Cookies und lokale Speicherung`,
        body: `| Name | Anbieter | Zweck | Dauer | Einordnung |
| --- | --- | --- | --- | --- |
| p_session_token (ggf. mit Zusatz) | Pangolin (Reverse-Proxy, eigene Infrastruktur) | Anmeldung und Zugangsschutz | 30 Tage; verlängert sich bei Nutzung | technisch erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG) |
| inbox-walk.mail-colors (localStorage) | Inbox Walk | speichert die gewählte Darstellung von E-Mails (dunkel oder Originalfarben) | bis zur Änderung oder Löschung im Browser | technisch erforderlich, da vom Nutzer ausdrücklich gewählte Einstellung (§ 25 Abs. 2 Nr. 2 TDDDG) |

Darüber hinaus setzt Inbox Walk keine Cookies und nutzt weder sessionStorage noch IndexedDB. Die Nutzungsanalyse und die Fehlerüberwachung speichern nichts im Browser.

Die Seiten Impressum und Datenschutzerklärung setzen keine Cookies.`,
      },
      {
        heading: `Ihre Rechte`,
        body: `Sie haben gegenüber dem Verantwortlichen folgende Rechte hinsichtlich Ihrer personenbezogenen Daten:

- Auskunft (Art. 15 DSGVO)
- Berichtigung (Art. 16 DSGVO)
- Löschung (Art. 17 DSGVO)
- Einschränkung der Verarbeitung (Art. 18 DSGVO)
- Datenübertragbarkeit (Art. 20 DSGVO)
- Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO): Sie können eine erteilte Einwilligung jederzeit widerrufen. Die Rechtmäßigkeit der Verarbeitung vor dem Widerruf bleibt unberührt.

**Widerspruchsrecht (Art. 21 DSGVO):** Soweit eine Verarbeitung auf Art. 6 Abs. 1 lit. f DSGVO beruht, können Sie aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit widersprechen.

Zur Ausübung Ihrer Rechte genügt eine Nachricht an [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com).

Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, insbesondere in dem Mitgliedstaat Ihres gewöhnlichen Aufenthalts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes (Art. 77 DSGVO).`,
      },
      {
        heading: `Pflicht zur Bereitstellung`,
        body: `Sie sind nicht verpflichtet, personenbezogene Daten bereitzustellen. Ohne die technisch notwendigen Verbindungsdaten kann die Website jedoch nicht ausgeliefert werden, und ohne Anmeldung sind die geschützten Bereiche nicht nutzbar.`,
      },
      {
        heading: `Änderungen`,
        body: `Diese Datenschutzerklärung wird angepasst, wenn sich die Website oder die Rechtslage ändert. Es gilt die jeweils hier veröffentlichte Fassung.`,
      },
    ],
  },
  en: {
    title: `Privacy Policy`,
    intro: `Last updated: ${LEGAL_DATE.en}`,
    numbered: true,
    sections: [
      {
        heading: `Controller`,
        body: `The controller responsible for processing personal data on https://inbox-walk.heerlab.com is:

Tobias Heer
c/o Impressumservice Dein-Impressum
Stettiner Str. 41
35410 Hungen
Germany

E-mail: [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com)

No data protection officer has been appointed, as there is no legal obligation to do so.`,
      },
      {
        heading: `Overview`,
        body: `This policy explains which personal data is processed when you use Inbox Walk, for what purposes, on which legal basis, and for how long. Inbox Walk is a private, non-commercial project. With Inbox Walk, the controller uses an AI model to sort unread e-mails from his own Fastmail mailbox into tasks, works through them and prepares reply drafts; the application does not send e-mails itself. This also involves processing personal data of people who write to the controller or are mentioned in e-mails.

Personal data is not sold and not used for advertising. There is no automated decision-making, including profiling, within the meaning of Art. 22 GDPR.`,
      },
      {
        heading: `Hosting and delivery`,
        body: `Inbox Walk runs on the controller's own server infrastructure in Germany. Requests from the internet reach the application through a reverse proxy on a virtual server operated by netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Germany (data center in Nuremberg). netcup processes the data as a processor under a data processing agreement pursuant to Art. 28 GDPR. The connection is TLS-encrypted up to the reverse proxy and forwarded from there to the controller's infrastructure through an encrypted tunnel.

The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the secure and reliable provision of the website.

The application data described in the section "Mail processing and stored data" is backed up regularly. Backups are stored within the controller's own infrastructure in Germany and overwritten after no more than three months. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is protection against data loss.`,
      },
      {
        heading: `Server log files`,
        body: `For every request, the reverse proxy automatically stores the following data:

- IP address of the requesting device
- date and time of access
- requested address (path including parameters), HTTP method and protocol
- HTTP status code, amount of data transferred, and response time
- browser identifier (user agent)
- TLS version and cipher used
- target service

The Cookie and Authorization headers are redacted. URL paths and query parameters are logged.

This data is used to operate the site, analyse errors, and defend against attacks and abuse. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the stability and security of the service. Log files are deleted automatically after 14 days.

Pangolin, the reverse proxy, also keeps a request log (requested address, time, IP address, result of the access check) for 14 days, an authentication log of sign-ins (user, time, IP address, result) for 90 days, and a network log for 30 days. These logs are used for operation, security and access control. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is secure operation and access protection.

CrowdSec keeps local alerts about detected attacks (IP address, time, type of attack) on the reverse proxy. They are generally deleted after seven days; blocks normally last four hours. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is protection against attacks.

The application itself keeps no access log of IP addresses or request contents. Its operational messages (start and stop, number of processed messages, error messages) are written only as short-lived container logs on the controller's own infrastructure and are not collected centrally. They are removed when Kubernetes rotates the logs or replaces the container. Error messages can contain technical details such as attachment file names or error texts from Fastmail or OpenAI. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is error analysis and operation.`,
      },
      {
        heading: `Protection against attacks (CrowdSec)`,
        body: `To protect against attacks, the security software CrowdSec automatically analyses the server log files and blocks IP addresses that are clearly the source of attacks (for example mass login attempts or scanning for vulnerabilities). When CrowdSec detects an attack, the IP address, time and type of attack are sent to CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, France. CrowdSec uses these reports for a shared blocklist that protects many servers. No data is sent to CrowdSec during normal browsing.

The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is protecting the website and its users from attacks.

According to CrowdSec, the controller and CrowdSec are jointly responsible for this processing (Art. 26 GDPR): CrowdSec is responsible for operating its central services and blocklists, the controller for its use on this server. You can exercise your rights against either of them; CrowdSec can be reached at [dpo@crowdsec.net](mailto:dpo@crowdsec.net). CrowdSec may pass the reported data on to members and partners of its network. According to CrowdSec, transfers to countries outside the EU are based on the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR).

Full IP addresses are generally retained for no more than three months and then progressively generalised. CrowdSec describes exceptions of up to one year before anonymisation for certain attack analyses and training purposes. Details: [crowdsec.net/privacy-policy](https://www.crowdsec.net/privacy-policy).`,
      },
      {
        heading: `Sign-in (single sign-on)`,
        body: `Inbox Walk is only accessible to invited people. Sign-in is handled by the Pangolin reverse proxy with Pocket-ID, an identity service self-hosted on the controller's infrastructure. This processes your user name, e-mail address, group membership, time of sign-in and IP address. After sign-in, Pangolin sets a session cookie that is technically required for access.

The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is restricting access to authorised people. The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is withdrawn. Sign-in logs are deleted after 90 days. Backups are overwritten after no more than three months.`,
      },
      {
        heading: `Mail processing and stored data`,
        body: `Inbox Walk reads the controller's unread incoming mail through Fastmail's JMAP interface. For sorting context, the application may search the entire mailbox, including read mail. It processes sender and recipient names and addresses, subjects, dates, preview excerpts, message bodies, attachments, and the controller's sender identities and signatures.

Changes in the mailbox happen only after an explicit action by the user: exactly the selected messages are marked as read, assigned the label "Newsletter abmelden", or saved as reply drafts. Inbox Walk does not send e-mail.

A SQLite database on the controller's own infrastructure in Germany stores:

- for each message, its ID, thread ID, subject, date, sender and recipient names and addresses, Fastmail's short preview excerpt, mailbox names and processing state;
- bucket titles and summaries written by the AI model;
- the memory note written by the user and proposals for it;
- an event log of sorting actions with IDs and counts;
- reply-editor state with recipients, subject, draft text and notes.

Message bodies and attachment contents are not stored in the database. They are held only temporarily in the server's memory during processing. A document-extraction service (Apache Tika) on the controller's own infrastructure converts document attachments for reply drafts to text. Temporary files are deleted with the container's temporary storage.

Messages that are done or no longer unread in Fastmail are deleted after 60 days, together with empty closed buckets. Open or parked messages and buckets that still contain messages have no fixed deletion period and remain until handled. The memory note stays until the user changes it. The event log keeps the latest 5,000 entries, and memory proposals the latest 50. Reply-editor state is deleted with its message. The original e-mails remain in the Fastmail mailbox; Inbox Walk does not delete them there. For backups, see the section "Hosting and delivery".

The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the efficient handling of the controller's own e-mail correspondence.

The OpenAI login record (OAuth tokens) is stored on the server so the AI model can be used. It remains until the login is removed.`,
      },
      {
        heading: `Fastmail (mailbox)`,
        body: `Inbox Walk accesses the controller's mailbox at Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as described above. Fastmail processes the mailbox as a processor. For transfers to third countries, Standard Contractual Clauses, privacy information and deletion rules, see the section "Contact by e-mail".`,
      },
      {
        heading: `AI processing by OpenAI`,
        body: `For sorting and reply drafts, Inbox Walk uses an AI model from OpenAI Ireland Ltd, 1st Floor, The Liffey Trust Centre, 117–126 Sheriff Street Upper, Dublin 1, D01 YC43, Ireland. Access is through the controller's ChatGPT Pro subscription via the Codex interface on chatgpt.com. Sign-in to OpenAI uses auth.openai.com.

For sorting, the details of new messages (sender, recipients, subject, date, preview), existing bucket texts and the memory note are sent. On the model's request, search results and message texts of up to 12,000 characters are also sent. For reply drafts, the full thread with addresses, subjects, dates and bodies, images from attachments, text extracted from document attachments, and the user's notes and draft are sent.

The purpose is sorting mail and preparing reply drafts. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is the efficient handling of the controller's own correspondence.

Use is governed by OpenAI's terms for individual ChatGPT subscriptions. OpenAI offers no data processing agreement under Art. 28 GDPR for this plan and is therefore not bound as a processor. Under these terms, OpenAI may use the content to improve its models unless this is deactivated in the account settings.

OpenAI also processes data outside the EU, in particular in the USA. According to OpenAI, transfers are based on adequacy decisions of the European Commission or Standard Contractual Clauses. Inbox Walk asks OpenAI not to store the requests (store: false). Nevertheless, OpenAI's retention is governed by its privacy policy; no fixed deletion period is assured. Details: [OpenAI privacy policy](https://openai.com/policies/eu-privacy-policy/) and [OpenAI terms of use](https://openai.com/policies/eu-terms-of-use/).`,
      },
      {
        heading: `External images in e-mails`,
        body: `When you open a message, the Inbox Walk server acts as a proxy to load images that the sender embedded from external servers. The browser does not load these images directly. The external server receives the Inbox Walk server's IP address, the image address (which may contain tracking identifiers set by the sender), the time and a generic browser identifier. It receives neither your IP address nor cookies or mail contents. Images are not stored.

The sender of each e-mail decides which servers these are. Their location and data handling are outside the controller's control. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is displaying e-mails as intended while hiding your IP address.`,
      },
      {
        heading: `Usage analytics (Umami)`,
        body: `Umami is self-hosted on the controller's own infrastructure in Germany at umami.heerlab.com. No third party is involved. It collects views of fixed virtual pages (such as list, bucket and settings), workflow events with counts and duration ranges, and performance metrics such as load and response times. It also collects masked session recordings (replay) and heatmaps of click and scroll positions with page and window size.

All text and inputs are masked in recordings; mail and editor areas are fully excluded. Mail contents, subjects, addresses, bucket titles, notes, reply texts and Fastmail IDs are not transmitted. Umami processes the IP address and browser identifier of the request to derive a session identifier, browser, operating system, device type and approximate location. Umami sets no cookies and stores no data in your browser.

The purpose is improving the application's workflow and performance. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is an application that is easy to use and fast. Access to information in the browser is limited to what is technically necessary for the service explicitly requested by the only user of this internal tool (Section 25(2) no. 2 TDDDG).

Automatic deletion of analytics data is not currently configured; it is deleted once it is no longer needed for analysis. For backups, see the section "Hosting and delivery".`,
      },
      {
        heading: `Error tracking (GlitchTip)`,
        body: `GlitchTip is self-hosted on the controller's own infrastructure in Germany at glitchtip.heerlab.com. When errors occur in the browser or on the server, the error type with a generic message, code location (file and line), release and environment, and time are sent. For a sample of 10% of requests, the route template and timings are also collected.

Error messages, request contents, cookies, headers, mail contents and addresses are removed before sending. The sending browser's IP address reaches the service for technical reasons. The purpose is detecting and fixing errors. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is the error-free operation of the application. Error events and performance data are deleted automatically after 90 days.`,
      },
      {
        heading: `Contact by e-mail`,
        body: `If you contact us by e-mail, your e-mail address, the content of your message and the technical details of the e-mail are processed to answer your request. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is being able to answer requests.

The mailboxes are hosted by Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as a processor. Data may be transferred to countries outside the EU, in particular Australia, the USA and India. For these transfers, Fastmail uses the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR). Details: [Fastmail privacy policy](https://www.fastmail.com/policies/privacy/), [data processing agreement](https://www.fastmail.com/policies/dpa/) and [Standard Contractual Clauses](https://www.fastmail.com/policies/dpa/section3/). You can obtain a copy of the safeguards by writing to [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com).

The controller deletes messages after dealing with the request unless retention remains necessary. Fastmail may subsequently retain backup and log data under its published deletion rules.`,
      },
      {
        heading: `Cookies and local storage`,
        body: `| Name | Provider | Purpose | Duration | Classification |
| --- | --- | --- | --- | --- |
| p_session_token (possibly with a suffix) | Pangolin (reverse proxy, own infrastructure) | Sign-in and access protection | 30 days; extended while in use | Technically necessary (Section 25(2) no. 2 TDDDG) |
| inbox-walk.mail-colors (localStorage) | Inbox Walk | Stores the selected display of e-mails (dark or original colours) | Until changed or deleted in the browser | Technically necessary as a setting explicitly chosen by the user (Section 25(2) no. 2 TDDDG) |

Beyond this, Inbox Walk sets no cookies and uses neither sessionStorage nor IndexedDB. Usage analytics and error tracking store nothing in the browser.

The Legal Notice and Privacy Policy pages set no cookies.`,
      },
      {
        heading: `Your rights`,
        body: `You have the following rights regarding your personal data:

- access (Art. 15 GDPR)
- rectification (Art. 16 GDPR)
- erasure (Art. 17 GDPR)
- restriction of processing (Art. 18 GDPR)
- data portability (Art. 20 GDPR)
- withdrawal of consent (Art. 7(3) GDPR): you may withdraw consent at any time. Withdrawal does not affect the lawfulness of processing before withdrawal.

**Right to object (Art. 21 GDPR):** Where processing is based on Art. 6(1)(f) GDPR, you may object at any time on grounds relating to your particular situation.

To exercise your rights, simply send a message to [datenschutz-inbox-walk@heerlab.com](mailto:datenschutz-inbox-walk@heerlab.com).

You also have the right to lodge a complaint with a data protection supervisory authority, in particular in the member state of your habitual residence, place of work or place of the alleged infringement (Art. 77 GDPR).`,
      },
      {
        heading: `Obligation to provide data`,
        body: `You are not obliged to provide personal data. However, the website cannot be delivered without the technically necessary connection data, and the protected areas cannot be used without signing in.`,
      },
      {
        heading: `Changes`,
        body: `This privacy policy is updated when the website or the legal situation changes. The version published here applies.`,
      },
    ],
  },
}
