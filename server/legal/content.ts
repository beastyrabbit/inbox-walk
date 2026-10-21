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

Zur Datensicherung werden regelmäßig Sicherungskopien innerhalb der eigenen Infrastruktur erstellt; sie werden nach Ablauf ihrer Aufbewahrungszeit überschrieben.`,
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

Darüber hinaus protokolliert der Reverse-Proxy Anfragen und Anmeldungen zur Zugangskontrolle und zum Schutz vor Angriffen; diese Protokolle werden nach höchstens 90 Tagen gelöscht. Die Anwendung selbst schreibt nur kurzlebige Betriebs- und Fehlermeldungen, die nicht zentral gesammelt werden. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO.`,
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

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, den Zugang auf berechtigte Personen zu beschränken. Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht.`,
      },
      {
        heading: `E-Mail-Verarbeitung und gespeicherte Daten`,
        body: `Inbox Walk liest ungelesene E-Mails aus dem Fastmail-Postfach des Verantwortlichen und durchsucht zur Einordnung das gesamte Postfach. Dabei werden Angaben zu Absendern und Empfängern, Betreffzeilen, Inhalte und Anhänge verarbeitet. Änderungen im Postfach, etwa das Markieren als gelesen, das Setzen eines Labels oder das Speichern von Antwortentwürfen, erfolgen nur auf ausdrückliche Aktion des Nutzers. Inbox Walk versendet keine E-Mails.

Die Datenbank der Anwendung auf der eigenen Infrastruktur speichert Nachrichtenmetadaten und kurze Vorschautexte, Aufgabengruppen und Zusammenfassungen, Notizen und den Entwurfszustand. Nachrichteninhalte und Anhänge werden nicht gespeichert, sondern nur vorübergehend verarbeitet. Dokumentanhänge werden auf der eigenen Infrastruktur in Text umgewandelt.

Erledigte Nachrichten werden nach 60 Tagen gelöscht; die übrigen gespeicherten Daten werden spätestens nach 10 Jahren gelöscht. Die ursprünglichen E-Mails bleiben im Fastmail-Postfach. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in der effizienten Bearbeitung der eigenen Korrespondenz.`,
      },
      {
        heading: `Fastmail (E-Mail-Postfach)`,
        body: `Inbox Walk greift wie oben beschrieben auf das Postfach des Verantwortlichen bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, zu. Fastmail verarbeitet das Postfach als Auftragsverarbeiter. Zu Übermittlungen in Drittländer, Standardvertragsklauseln, Datenschutzhinweisen und Löschregeln siehe Abschnitt „Kontakt per E-Mail“.`,
      },
      {
        heading: `KI-Verarbeitung durch OpenAI`,
        body: `Für die Sortierung und für Antwortentwürfe werden E-Mail-Inhalte (Absender, Empfänger, Betreff, Text, Anhänge) sowie Notizen an die OpenAI Ireland Ltd, 1st Floor, The Liffey Trust Centre, 117–126 Sheriff Street Upper, Dublin 1, D01 YC43, Irland, übermittelt und dort von einem KI-Modell verarbeitet. OpenAI verarbeitet Daten auch außerhalb der EU, insbesondere in den USA; nach Angaben von OpenAI auf Grundlage von Angemessenheitsbeschlüssen oder Standardvertragsklauseln. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der effizienten Bearbeitung der eigenen Korrespondenz. Details: [OpenAI-Datenschutzerklärung](https://openai.com/policies/eu-privacy-policy/).`,
      },
      {
        heading: `Externe Bilder in E-Mails`,
        body: `Beim Öffnen einer E-Mail lädt der Inbox-Walk-Server externe Bilder als Proxy; der externe Server erhält dabei die IP-Adresse des Servers und die Bildadresse, nicht Ihre IP-Adresse. Die Bilder werden nicht gespeichert. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, E-Mails wie vorgesehen darzustellen und dabei Ihre IP-Adresse zu verbergen.`,
      },
      {
        heading: `Nutzungsanalyse und Fehlerüberwachung`,
        body: `Umami und GlitchTip werden auf der eigenen Infrastruktur des Verantwortlichen in Deutschland betrieben; es ist kein Drittanbieter beteiligt. Umami erfasst Aufrufe fester App-Ansichten, Arbeitsablauf-Ereignisse, Leistungsdaten sowie maskierte Sitzungsaufzeichnungen und Heatmaps ohne E-Mail-Inhalte und setzt weder Cookies noch andere Daten im Browser. GlitchTip erhält Fehlerberichte, aus denen persönliche Angaben entfernt werden. IP-Adresse und Browser-Kennung erreichen beide Dienste technisch bedingt.

Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in einer gut nutzbaren, schnellen und fehlerfreien Anwendung. Der Zugriff auf Informationen im Browser beschränkt sich auf das technisch Erforderliche (§ 25 Abs. 2 Nr. 2 TDDDG). Analysedaten werden nach 25 Monaten gelöscht, Sitzungsaufzeichnungen und Heatmaps nach 30 Tagen, Fehlerberichte nach 90 Tagen.`,
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
| Sitzungs-Cookie | Pangolin (Anmeldung) | Zugang nach Anmeldung | bis zu 30 Tage, bei Nutzung verlängert | technisch erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG) |
| Darstellungs-Einstellung (localStorage) | Inbox Walk | gewählte Darstellung von E-Mails | bis zur Änderung | technisch erforderlich |

Weitere Cookies oder Browserspeicher werden nicht verwendet; die rechtlichen Seiten setzen keine Cookies und speichern keine Daten im Browser.`,
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

For data protection against loss, backup copies are created regularly within the controller's own infrastructure; they are overwritten once their retention period expires.`,
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

The reverse proxy also logs requests and sign-ins for access control and protection against attacks; these logs are deleted after no more than 90 days. The application itself writes only short-lived operational and error messages, which are not collected centrally. The legal basis is Art. 6(1)(f) GDPR.`,
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

The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is restricting access to authorised people. The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is withdrawn. Sign-in logs are deleted after 90 days.`,
      },
      {
        heading: `Mail processing and stored data`,
        body: `Inbox Walk reads unread e-mails from the controller's Fastmail mailbox and searches the entire mailbox for context. This processes sender and recipient details, subjects, contents and attachments. Changes in the mailbox, such as marking messages as read, applying a label or saving reply drafts, happen only on explicit user action. Inbox Walk does not send e-mails.

The application's database on the controller's own infrastructure stores message metadata and short previews, task groups and summaries, notes and draft state. Message bodies and attachments are not stored, but only processed temporarily. Document attachments are converted to text on the controller's own infrastructure.

Completed messages are deleted after 60 days; other stored data is deleted after 10 years at the latest. The original e-mails remain in the Fastmail mailbox. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the efficient handling of the controller's own correspondence.`,
      },
      {
        heading: `Fastmail (mailbox)`,
        body: `Inbox Walk accesses the controller's mailbox at Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as described above. Fastmail processes the mailbox as a processor. For transfers to third countries, Standard Contractual Clauses, privacy information and deletion rules, see the section "Contact by e-mail".`,
      },
      {
        heading: `AI processing by OpenAI`,
        body: `For sorting and reply drafts, e-mail contents (sender, recipients, subject, text, attachments) and notes are sent to OpenAI Ireland Ltd, 1st Floor, The Liffey Trust Centre, 117–126 Sheriff Street Upper, Dublin 1, D01 YC43, Ireland, and processed there by an AI model. OpenAI also processes data outside the EU, in particular in the USA; according to OpenAI, this is based on adequacy decisions or Standard Contractual Clauses. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is the efficient handling of the controller's own correspondence. Details: [OpenAI privacy policy](https://openai.com/policies/eu-privacy-policy/).`,
      },
      {
        heading: `External images in e-mails`,
        body: `When you open an e-mail, the Inbox Walk server loads external images as a proxy; the external server receives the server's IP address and the image address, not your IP address. Images are not stored. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is displaying e-mails as intended while hiding your IP address.`,
      },
      {
        heading: `Usage analytics and error tracking`,
        body: `Umami and GlitchTip are self-hosted on the controller's own infrastructure in Germany; no third party is involved. Umami records views of fixed app pages, workflow events, performance data, and masked session recordings and heatmaps without mail contents, and uses neither cookies nor other browser storage. GlitchTip receives error reports with personal details removed. IP addresses and browser identifiers reach both services for technical reasons.

The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is an application that is easy to use, fast and free of errors. Access to information in the browser is limited to what is technically necessary (Section 25(2) no. 2 TDDDG). Analytics data is deleted after 25 months, session recordings and heatmaps after 30 days, and error reports after 90 days.`,
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
| Session cookie | Pangolin (sign-in) | Access after sign-in | up to 30 days, extended while in use | technically necessary (Section 25(2) no. 2 TDDDG) |
| Display setting (localStorage) | Inbox Walk | selected display of e-mails | until changed | technically necessary |

No other cookies or browser storage are used; the legal pages set no cookies and store no data in the browser.`,
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
