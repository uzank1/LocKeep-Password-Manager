/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Internationalization (i18n)
 * ============================================================================
 * Translations are embedded directly to avoid fetch() dependency.
 * CSP blocks connect-src, so fetch-based loading would silently fail.
 *
 * Supports: English (en), German (de), Turkish (tr)
 * Usage:    I18n.t('key')  |  I18n.setLanguage('de')
 * DOM:      data-i18n="key" on any element
 * ============================================================================
 */

'use strict';

const I18n = (function () {

  // ─── Embedded Translations ──────────────────────────────────────────────
  const TRANSLATIONS = {

    // ═══════════════════════════════════════════════════════════════════════
    // ENGLISH
    // ═══════════════════════════════════════════════════════════════════════
    en: {
      app: {
        title: "LocKeep",
        subtitle: "Password Manager",
        tagline: "Strictly Offline. Zero-Knowledge Security."
      },
      lock: {
        title: "Unlock Your Vault",
        createTitle: "Create Your Vault",
        masterPassword: "Master Password",
        confirmPassword: "Confirm Master Password",
        unlock: "Unlock Vault",
        create: "Create Vault",
        creating: "Creating vault\u2026",
        unlocking: "Deriving key\u2026",
        wrongPassword: "Incorrect master password. Please try again.",
        passwordMismatch: "Passwords do not match.",
        minLength: "Master password does not meet the requirements below.",
        vaultCreated: "Vault created successfully!",
        zeroKnowledgeWarning: "CRITICAL: Your Master Password is the absolute key to your vault. LocKeep operates on a strict Zero-Knowledge architecture. If you forget this password, your data cannot be recovered by anyone. Keep it strictly safe.",
        requirements: {
          title: "Password Requirements",
          minLength: "At least 14 characters",
          uppercase: "At least one uppercase letter (A\u2013Z)",
          lowercase: "At least one lowercase letter (a\u2013z)",
          number: "At least one number (0\u20139)",
          special: "At least one special character (!@#$%\u2026)"
        }
      },
      vault: {
        searchPlaceholder: "Search for your passwords\u2026",
        noEntries: "No passwords have been saved yet.",
        noResults: "No matching entries found.",
        addNew: "Add New Password",
        totalEntries: "{{count}} passwords stored"
      },
      entry: {
        title: "Title",
        username: "Username / Email",
        password: "Password",
        url: "Website URL",
        notes: "Notes",
        category: "Category",
        favorite: "Mark as Favorite",
        createdAt: "Created",
        updatedAt: "Last Modified",
        copyUsername: "Copy Username",
        copyPassword: "Copy Password",
        edit: "Edit Entry",
        delete: "Delete",
        save: "Save",
        cancel: "Cancel",
        deleteConfirm: "Are you sure you want to permanently delete this entry?",
        hoverToReveal: "Hover to reveal"
      },
      generator: {
        title: "Password Generator",
        generate: "Generate Secure Password",
        copy: "Copy to Clipboard",
        placeholder: "Click generate to create a secure password"
      },
      strength: {
        very_weak: "Very Weak",
        weak: "Weak",
        fair: "Fair",
        strong: "Strong",
        very_strong: "Very Strong",
        excellent: "Excellent"
      },
      "import": {
        title: "Import Passwords",
        description: "Import passwords from another password manager.",
        selectFile: "Select File",
        supportedFormats: "Supported: Bitwarden CSV, 1Password CSV, Chrome CSV, JSON",
        importing: "Importing\u2026",
        success: "Successfully imported {{count}} entries.",
        error: "Import failed."
      },
      "export": {
        title: "Export Passwords",
        description: "Export your passwords for use in another password manager.",
        selectFormat: "Select Target Format",
        exportBtn: "Export Passwords",
        warning: "Warning: The exported file will contain your passwords in plaintext. Delete it securely after importing into your target application.",
        success: "Successfully exported {{count}} entries.",
        error: "Export failed."
      },
      settings: {
        title: "Settings",
        language: "Language",
        autoLock: "Auto-Lock Timeout",
        autoLockOptions: { "1": "1 Minute", "5": "5 Minutes", "15": "15 Minutes", "0": "Never" },
        startup: "Startup",
        startWithWindows: "Start with Windows",
        startWithWindowsDescription: "Open LocKeep automatically when you sign in to Windows.",
        vaultLocation: "Vault Location",
        currentPath: "Current path",
        changePath: "Change Location",
        resetPath: "Reset to Default",
        changeMasterPassword: "Change Master Password",
        about: "About",
        version: "Version"
      },
      updates: {
        title: "Application Updates",
        newVersionAvailable: "A new version is available",
        check: "Check for updates",
        update: "Update",
        checking: "Checking for updates\u2026",
        currentVersion: "Current version: {{version}}",
        versionAvailable: "Version {{version}} is available.",
        upToDate: "LocKeep is up to date.",
        downloading: "Downloading update: {{progress}}%",
        restarting: "Update downloaded. Restarting LocKeep\u2026",
        error: "The update could not be completed. Please try again.",
        installedOnly: "Updates can only be checked in the installed application.",
        extensionReloadTitle: "Reload the browser extension",
        extensionReloadIntro: "LocKeep has been updated. Reload the browser extension so it uses the new version.",
        extensionReloadStep1: "Open your browser's extensions page:",
        extensionReloadStep2: "Find LocKeep Password Manager.",
        extensionReloadStep3: "Click Reload next to the extension.",
        acknowledge: "Got it"
      },
      clipboard: {
        copied: "{{label}} copied to clipboard.",
        clearing: "Clipboard clears in {{seconds}}s",
        cleared: "Clipboard cleared."
      },
      nav: {
        passwords: "Passwords",
        generator: "Password Generator",
        "import": "Import",
        "export": "Export",
        integration: "Browser Integration",
        settings: "Settings",
        lock: "Lock Vault"
      },
      integration: {
        title: "Browser Integration",
        magicInstall: "Seamless Installation",
        instructions: "1. Open your browser's extension page (e.g. brave://extensions or chrome://extensions) and enable Developer Mode.<br>2. Drag the LocKeep box below directly into your browser window!",
        dragMe: "LocKeep Extension",
        dragSubtitle: "Drag me to browser!",
        securityNote: "Security Note: LocKeep connects locally via a secure End-to-End Encrypted (AES-256-GCM) Native Messaging bridge. Your data never leaves your device."
      },
      common: {
        close: "Close",
        confirm: "Confirm",
        cancel: "Cancel",
        yes: "Yes",
        no: "No",
        error: "An error occurred.",
        success: "Operation successful.",
        loading: "Loading\u2026"
      },
      extension: {
        generatePassword: "\uD83D\uDD10 Generate Strong Password?",
        passwordGenerated: "\u2705 Password Generated!",
        savePassword: "\uD83D\uDD10 Save Password?",
        save: "Save",
        dismiss: "Dismiss",
        domain: "Domain",
        username: "Username",
        password: "Password",
        header: "\uD83D\uDD12 LocKeep",
        popupConnected: "\u2705 Connected to LocKeep desktop app",
        popupDisconnected: "\u274C LocKeep desktop app not connected",
        popupChecking: "Checking connection\u2026",
        popupTagline: "Strictly offline password manager"
      }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // GERMAN
    // ═══════════════════════════════════════════════════════════════════════
    de: {
      app: {
        title: "LocKeep",
        subtitle: "Passwort-Manager",
        tagline: "Strikt Offline. Zero-Knowledge-Sicherheit."
      },
      lock: {
        title: "Tresor Entsperren",
        createTitle: "Tresor Erstellen",
        masterPassword: "Master-Passwort",
        confirmPassword: "Master-Passwort best\u00e4tigen",
        unlock: "Tresor entsperren",
        create: "Tresor erstellen",
        creating: "Tresor wird erstellt\u2026",
        unlocking: "Schl\u00fcssel wird abgeleitet\u2026",
        wrongPassword: "Falsches Master-Passwort. Bitte erneut versuchen.",
        passwordMismatch: "Passw\u00f6rter stimmen nicht \u00fcberein.",
        minLength: "Master-Passwort erf\u00fcllt die folgenden Anforderungen nicht.",
        vaultCreated: "Tresor erfolgreich erstellt!",
        zeroKnowledgeWarning: "KRITISCH: Ihr Master-Passwort ist der absolute Schl\u00fcssel zu Ihrem Tresor. LocKeep arbeitet mit einer strikten Zero-Knowledge-Architektur. Wenn Sie dieses Passwort vergessen, k\u00f6nnen Ihre Daten von niemandem wiederhergestellt werden. Bewahren Sie es strikt sicher auf.",
        requirements: {
          title: "Passwort-Anforderungen",
          minLength: "Mindestens 14 Zeichen",
          uppercase: "Mindestens ein Gro\u00dfbuchstabe (A\u2013Z)",
          lowercase: "Mindestens ein Kleinbuchstabe (a\u2013z)",
          number: "Mindestens eine Zahl (0\u20139)",
          special: "Mindestens ein Sonderzeichen (!@#$%\u2026)"
        }
      },
      vault: {
        searchPlaceholder: "Passw\u00f6rter durchsuchen\u2026",
        noEntries: "Noch keine Passw\u00f6rter gespeichert.",
        noResults: "Keine passenden Eintr\u00e4ge gefunden.",
        addNew: "Neues Passwort hinzuf\u00fcgen",
        totalEntries: "{{count}} Passw\u00f6rter gespeichert"
      },
      entry: {
        title: "Titel",
        username: "Benutzername / E-Mail",
        password: "Passwort",
        url: "Webseiten-URL",
        notes: "Notizen",
        category: "Kategorie",
        favorite: "Als Favorit markieren",
        createdAt: "Erstellt",
        updatedAt: "Zuletzt ge\u00e4ndert",
        copyUsername: "Benutzername kopieren",
        copyPassword: "Passwort kopieren",
        edit: "Eintrag bearbeiten",
        delete: "L\u00f6schen",
        save: "Speichern",
        cancel: "Abbrechen",
        deleteConfirm: "M\u00f6chten Sie diesen Eintrag wirklich dauerhaft l\u00f6schen?",
        hoverToReveal: "Hover zum Anzeigen"
      },
      generator: {
        title: "Passwort-Generator",
        generate: "Sicheres Passwort generieren",
        copy: "In Zwischenablage kopieren",
        placeholder: "Klicken Sie auf Generieren, um ein sicheres Passwort zu erstellen"
      },
      strength: {
        very_weak: "Sehr Schwach", weak: "Schwach", fair: "Mittel",
        strong: "Stark", very_strong: "Sehr Stark", excellent: "Ausgezeichnet"
      },
      "import": {
        title: "Passw\u00f6rter importieren",
        description: "Passw\u00f6rter aus einem anderen Passwort-Manager importieren.",
        selectFile: "Datei ausw\u00e4hlen",
        supportedFormats: "Unterst\u00fctzt: Bitwarden CSV, 1Password CSV, Chrome CSV, JSON",
        importing: "Importiere\u2026",
        success: "{{count}} Eintr\u00e4ge erfolgreich importiert.",
        error: "Import fehlgeschlagen."
      },
      "export": {
        title: "Passw\u00f6rter exportieren",
        description: "Exportieren Sie Ihre Passw\u00f6rter zur Verwendung in einem anderen Passwort-Manager.",
        selectFormat: "Zielformat ausw\u00e4hlen",
        exportBtn: "Passw\u00f6rter exportieren",
        warning: "Warnung: Die exportierte Datei enth\u00e4lt Ihre Passw\u00f6rter im Klartext. L\u00f6schen Sie sie nach dem Import sicher.",
        success: "{{count}} Eintr\u00e4ge erfolgreich exportiert.",
        error: "Export fehlgeschlagen."
      },
      settings: {
        title: "Einstellungen",
        language: "Sprache",
        autoLock: "Automatische Sperre",
        autoLockOptions: { "1": "1 Minute", "5": "5 Minuten", "15": "15 Minuten", "0": "Nie" },
        startup: "Autostart",
        startWithWindows: "Mit Windows starten",
        startWithWindowsDescription: "LocKeep bei der Windows-Anmeldung automatisch starten.",
        vaultLocation: "Tresor-Speicherort",
        currentPath: "Aktueller Pfad",
        changePath: "Speicherort \u00e4ndern",
        resetPath: "Auf Standard zur\u00fccksetzen",
        changeMasterPassword: "Master-Passwort \u00e4ndern",
        about: "\u00dcber",
        version: "Version"
      },
      updates: {
        title: "Anwendungsupdates",
        newVersionAvailable: "Eine neue Version ist verf\u00fcgbar",
        check: "Nach Updates suchen",
        update: "Aktualisieren",
        checking: "Updates werden gesucht\u2026",
        currentVersion: "Aktuelle Version: {{version}}",
        versionAvailable: "Version {{version}} ist verf\u00fcgbar.",
        upToDate: "LocKeep ist auf dem neuesten Stand.",
        downloading: "Update wird heruntergeladen: {{progress}}%",
        restarting: "Update heruntergeladen. LocKeep wird neu gestartet\u2026",
        error: "Das Update konnte nicht abgeschlossen werden. Bitte erneut versuchen.",
        installedOnly: "Updates k\u00f6nnen nur in der installierten Anwendung gesucht werden.",
        extensionReloadTitle: "Browser-Erweiterung neu laden",
        extensionReloadIntro: "LocKeep wurde aktualisiert. Laden Sie die Browser-Erweiterung neu, damit sie die neue Version verwendet.",
        extensionReloadStep1: "\u00d6ffnen Sie die Erweiterungsseite Ihres Browsers:",
        extensionReloadStep2: "Suchen Sie LocKeep Password Manager.",
        extensionReloadStep3: "Klicken Sie neben der Erweiterung auf Neu laden.",
        acknowledge: "Verstanden"
      },
      clipboard: {
        copied: "{{label}} in Zwischenablage kopiert.",
        clearing: "Zwischenablage wird in {{seconds}}s geleert",
        cleared: "Zwischenablage geleert."
      },
      nav: {
        passwords: "Passw\u00f6rter",
        generator: "Passwort-Generator",
        "import": "Importieren",
        "export": "Exportieren",
        integration: "Browser-Integration",
        settings: "Einstellungen",
        lock: "Tresor sperren"
      },
      integration: {
        title: "Browser-Integration",
        magicInstall: "Nahtlose Installation",
        instructions: "1. \u00d6ffnen Sie die Erweiterungsseite Ihres Browsers (z. B. brave://extensions oder chrome://extensions) und aktivieren Sie den Entwicklermodus.<br>2. Ziehen Sie das LocKeep-Feld unten direkt in Ihr Browserfenster!",
        dragMe: "LocKeep-Erweiterung",
        dragSubtitle: "Zieh mich in den Browser!",
        securityNote: "Sicherheitshinweis: LocKeep verbindet sich lokal \u00fcber eine sichere, End-to-End verschl\u00fcsselte (AES-256-GCM) Native Messaging-Br\u00fccke. Ihre Daten verlassen niemals Ihr Ger\u00e4t."
      },
      common: {
        close: "Schlie\u00dfen", confirm: "Best\u00e4tigen", cancel: "Abbrechen",
        yes: "Ja", no: "Nein", error: "Ein Fehler ist aufgetreten.",
        success: "Vorgang erfolgreich.", loading: "Laden\u2026"
      },
      extension: {
        generatePassword: "\uD83D\uDD10 Sicheres Passwort generieren?",
        passwordGenerated: "\u2705 Passwort generiert!",
        savePassword: "\uD83D\uDD10 Passwort speichern?",
        save: "Speichern",
        dismiss: "Verwerfen",
        domain: "Domain",
        username: "Benutzername",
        password: "Passwort",
        header: "\uD83D\uDD12 LocKeep",
        popupConnected: "\u2705 Verbunden mit LocKeep Desktop-App",
        popupDisconnected: "\u274C LocKeep Desktop-App nicht verbunden",
        popupChecking: "Verbindung wird gepr\u00fcft\u2026",
        popupTagline: "Strikt offline Passwort-Manager"
      }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TURKISH
    // ═══════════════════════════════════════════════════════════════════════
    tr: {
      app: {
        title: "LocKeep",
        subtitle: "\u015eifre Y\u00f6neticisi",
        tagline: "Tamamen \u00c7evrimd\u0131\u015f\u0131. Bilgi Payla\u015f\u0131ms\u0131z G\u00fcvenlik."
      },
      lock: {
        title: "Kasan\u0131z\u0131 A\u00e7\u0131n",
        createTitle: "Kasan\u0131z\u0131 Olu\u015fturun",
        masterPassword: "Ana \u015eifre",
        confirmPassword: "Ana \u015eifreyi Onaylay\u0131n",
        unlock: "Kasay\u0131 A\u00e7",
        create: "Kasa Olu\u015ftur",
        creating: "Kasa olu\u015fturuluyor\u2026",
        unlocking: "Anahtar t\u00fcretiliyor\u2026",
        wrongPassword: "Yanl\u0131\u015f ana \u015fifre. L\u00fctfen tekrar deneyin.",
        passwordMismatch: "\u015eifreler e\u015fle\u015fmiyor.",
        minLength: "Ana \u015fifre a\u015fa\u011f\u0131daki gereksinimleri kar\u015f\u0131lam\u0131yor.",
        vaultCreated: "Kasa ba\u015far\u0131yla olu\u015fturuldu!",
        zeroKnowledgeWarning: "KR\u0130T\u0130K: Ana \u015eifreniz kasan\u0131z\u0131n mutlak anahtar\u0131d\u0131r. LocKeep, kat\u0131 bir S\u0131f\u0131r Bilgi mimarisi ile \u00e7al\u0131\u015f\u0131r. Bu \u015fifreyi unutursan\u0131z, verileriniz hi\u00e7 kimse taraf\u0131ndan kurtar\u0131lamaz. Kesinlikle g\u00fcvende tutun.",
        requirements: {
          title: "\u015eifre Gereksinimleri",
          minLength: "En az 14 karakter",
          uppercase: "En az bir b\u00fcy\u00fck harf (A\u2013Z)",
          lowercase: "En az bir k\u00fc\u00e7\u00fck harf (a\u2013z)",
          number: "En az bir rakam (0\u20139)",
          special: "En az bir \u00f6zel karakter (!@#$%\u2026)"
        }
      },
      vault: {
        searchPlaceholder: "\u015eifrelerinizi aray\u0131n\u2026",
        noEntries: "Hen\u00fcz kaydedilmi\u015f \u015fifre bulunmuyor.",
        noResults: "E\u015fle\u015fen giri\u015f bulunamad\u0131.",
        addNew: "Yeni \u015eifre Ekle",
        totalEntries: "{{count}} \u015fifre kay\u0131tl\u0131"
      },
      entry: {
        title: "Ba\u015fl\u0131k",
        username: "Kullan\u0131c\u0131 Ad\u0131 / E-posta",
        password: "\u015eifre",
        url: "Web Sitesi URL'si",
        notes: "Notlar",
        category: "Kategori",
        favorite: "Favori olarak i\u015faretle",
        createdAt: "Olu\u015fturulma",
        updatedAt: "Son De\u011fi\u015fiklik",
        copyUsername: "Kullan\u0131c\u0131 Ad\u0131n\u0131 Kopyala",
        copyPassword: "\u015eifreyi Kopyala",
        edit: "Kayd\u0131 D\u00fczenle",
        delete: "Sil",
        save: "Kaydet",
        cancel: "\u0130ptal",
        deleteConfirm: "Bu kayd\u0131 kal\u0131c\u0131 olarak silmek istedi\u011finizden emin misiniz?",
        hoverToReveal: "G\u00f6rmek i\u00e7in \u00fczerine gelin"
      },
      generator: {
        title: "\u015eifre \u00dcretici",
        generate: "G\u00fcvenli \u015eifre \u00dcret",
        copy: "Panoya Kopyala",
        placeholder: "G\u00fcvenli bir \u015fifre olu\u015fturmak i\u00e7in \u00dcret butonuna t\u0131klay\u0131n"
      },
      strength: {
        very_weak: "\u00c7ok Zay\u0131f", weak: "Zay\u0131f", fair: "Orta",
        strong: "G\u00fc\u00e7l\u00fc", very_strong: "\u00c7ok G\u00fc\u00e7l\u00fc", excellent: "M\u00fckemmel"
      },
      "import": {
        title: "\u015eifreleri \u0130\u00e7e Aktar",
        description: "Ba\u015fka bir \u015fifre y\u00f6neticisinden \u015fifreleri i\u00e7e aktar\u0131n.",
        selectFile: "Dosya Se\u00e7",
        supportedFormats: "Desteklenen: Bitwarden CSV, 1Password CSV, Chrome CSV, JSON",
        importing: "\u0130\u00e7e aktar\u0131l\u0131yor\u2026",
        success: "{{count}} kay\u0131t ba\u015far\u0131yla i\u00e7e aktar\u0131ld\u0131.",
        error: "\u0130\u00e7e aktarma ba\u015far\u0131s\u0131z."
      },
      "export": {
        title: "\u015eifreleri D\u0131\u015fa Aktar",
        description: "\u015eifrelerinizi ba\u015fka bir \u015fifre y\u00f6neticisinde kullanmak i\u00e7in d\u0131\u015fa aktar\u0131n.",
        selectFormat: "Hedef Format Se\u00e7in",
        exportBtn: "\u015eifreleri D\u0131\u015fa Aktar",
        warning: "Uyar\u0131: D\u0131\u015fa aktar\u0131lan dosya \u015fifrelerinizi d\u00fcz metin olarak i\u00e7erecektir. \u0130\u00e7e aktard\u0131ktan sonra g\u00fcvenli bir \u015fekilde silin.",
        success: "{{count}} kay\u0131t ba\u015far\u0131yla d\u0131\u015fa aktar\u0131ld\u0131.",
        error: "D\u0131\u015fa aktarma ba\u015far\u0131s\u0131z."
      },
      settings: {
        title: "Ayarlar",
        language: "Dil",
        autoLock: "Otomatik Kilitleme S\u00fcresi",
        autoLockOptions: { "1": "1 Dakika", "5": "5 Dakika", "15": "15 Dakika", "0": "Asla" },
        startup: "Ba\u015flang\u0131\u00e7",
        startWithWindows: "Windows ile birlikte ba\u015flat",
        startWithWindowsDescription: "Windows oturumu a\u00e7\u0131ld\u0131\u011f\u0131nda LocKeep'i otomatik olarak ba\u015flat\u0131r.",
        vaultLocation: "Kasa Konumu",
        currentPath: "Mevcut konum",
        changePath: "Konumu De\u011fi\u015ftir",
        resetPath: "Varsay\u0131lana S\u0131f\u0131rla",
        changeMasterPassword: "Ana \u015eifreyi De\u011fi\u015ftir",
        about: "Hakk\u0131nda",
        version: "S\u00fcr\u00fcm"
      },
      updates: {
        title: "Uygulama G\u00fcncellemeleri",
        newVersionAvailable: "Yeni s\u00fcr\u00fcm mevcut",
        check: "G\u00fcncellemeleri kontrol et",
        update: "G\u00fcncelle",
        checking: "G\u00fcncellemeler kontrol ediliyor\u2026",
        currentVersion: "Mevcut s\u00fcr\u00fcm: {{version}}",
        versionAvailable: "{{version}} s\u00fcr\u00fcm\u00fc kullan\u0131labilir.",
        upToDate: "LocKeep en son s\u00fcr\u00fcmde.",
        downloading: "G\u00fcncelleme indiriliyor: {{progress}}%",
        restarting: "G\u00fcncelleme indirildi. LocKeep yeniden ba\u015flat\u0131l\u0131yor\u2026",
        error: "G\u00fcncelleme tamamlanamad\u0131. L\u00fctfen tekrar deneyin.",
        installedOnly: "G\u00fcncellemeler yaln\u0131zca kurulu uygulamada kontrol edilebilir.",
        extensionReloadTitle: "Taray\u0131c\u0131 eklentisini yeniden y\u00fckleyin",
        extensionReloadIntro: "LocKeep g\u00fcncellendi. Yeni s\u00fcr\u00fcm\u00fc kullanmas\u0131 i\u00e7in taray\u0131c\u0131 eklentisini yeniden y\u00fckleyin.",
        extensionReloadStep1: "Taray\u0131c\u0131n\u0131z\u0131n eklentiler sayfas\u0131n\u0131 a\u00e7\u0131n:",
        extensionReloadStep2: "LocKeep Password Manager eklentisini bulun.",
        extensionReloadStep3: "Eklentinin yan\u0131ndaki Yeniden y\u00fckle d\u00fc\u011fmesine bas\u0131n.",
        acknowledge: "Anlad\u0131m"
      },
      clipboard: {
        copied: "{{label}} panoya kopyaland\u0131.",
        clearing: "Pano {{seconds}} saniye i\u00e7inde temizlenecek",
        cleared: "Pano temizlendi."
      },
      nav: {
        passwords: "\u015eifreler",
        generator: "\u015eifre \u00dcretici",
        "import": "\u0130\u00e7e Aktar",
        "export": "D\u0131\u015fa Aktar",
        integration: "Taray\u0131c\u0131 Entegrasyonu",
        settings: "Ayarlar",
        lock: "Kasay\u0131 Kilitle"
      },
      integration: {
        title: "Taray\u0131c\u0131 Entegrasyonu",
        magicInstall: "Sorunsuz Kurulum",
        instructions: "1. Taray\u0131c\u0131n\u0131z\u0131n eklenti sayfas\u0131n\u0131 a\u00e7\u0131n (rn. brave://extensions veya chrome://extensions) ve Geli\u015ftirici Modunu etkinle\u015ftirin.<br>2. A\u015fa\u011f\u0131daki LocKeep kutusunu do\u011frudan taray\u0131c\u0131 pencerenize s\u00fcr\u00fckleyin!",
        dragMe: "LocKeep Eklentisi",
        dragSubtitle: "Beni taray\u0131c\u0131ya s\u00fcr\u00fckle!",
        securityNote: "G\u00fcvenlik Notu: LocKeep, g\u00fcvenli U\u00e7tan Uca \u015eifreli (AES-256-GCM) Yerel Mesajla\u015fma k\u00f6pr\u00fc\u00fc arac\u0131l\u0131\u011f\u0131yla yerel olarak ba\u011flan\u0131r. Verileriniz cihaz\u0131n\u0131zdan asla \u00e7\u0131kmaz."
      },
      common: {
        close: "Kapat", confirm: "Onayla", cancel: "\u0130ptal",
        yes: "Evet", no: "Hay\u0131r", error: "Bir hata olu\u015ftu.",
        success: "\u0130\u015flem ba\u015far\u0131l\u0131.", loading: "Y\u00fckleniyor\u2026"
      },
      extension: {
        generatePassword: "\uD83D\uDD10 G\u00fc\u00e7l\u00fc \u015eifre Olu\u015ftur?",
        passwordGenerated: "\u2705 \u015eifre Olu\u015fturuldu!",
        savePassword: "\uD83D\uDD10 \u015eifreyi Kaydet?",
        save: "Kaydet",
        dismiss: "Kapat",
        domain: "Domain",
        username: "Kullan\u0131c\u0131 Ad\u0131",
        password: "\u015eifre",
        header: "\uD83D\uDD12 LocKeep",
        popupConnected: "\u2705 LocKeep masa\u00fcst\u00fc uygulamas\u0131na ba\u011fl\u0131",
        popupDisconnected: "\u274C LocKeep masa\u00fcst\u00fc uygulamas\u0131 ba\u011fl\u0131 de\u011fil",
        popupChecking: "Ba\u011flant\u0131 kontrol ediliyor\u2026",
        popupTagline: "Tamamen \u00e7evrimd\u0131\u015f\u0131 \u015fifre y\u00f6neticisi"
      }
    }
  };

  // ─── State ────────────────────────────────────────────────────────────────
  let _currentLang = 'en';
  let _translations = TRANSLATIONS.en;

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns the translated string for a dot-notation key.
   * Falls back to English, then to the raw key.
   * Supports {{param}} interpolation.
   */
  function t(key, params) {
    let str = _get(_translations, key) || _get(TRANSLATIONS.en, key) || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(v));
      }
    }
    return str;
  }

  /**
   * Switches the active language and re-renders the entire DOM.
   * Persists the choice to vault settings.
   */
  function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) lang = 'en';
    _currentLang = lang;
    _translations = TRANSLATIONS[lang];
    // Keep the document language aligned with the visible UI language for
    // screen readers and any browser-level text handling.
    document.documentElement.lang = lang;
    updateDOM();
    if (window.vault && window.vault.saveSettings) {
      window.vault.saveSettings({ language: lang });
    }
  }

  /** Returns the current language code. */
  function getCurrentLanguage() { return _currentLang; }

  /** Returns the raw translations object for a language (used by extension sync). */
  function getTranslations(lang) { return TRANSLATIONS[lang] || TRANSLATIONS.en; }

  /**
   * Walks every element with data-i18n and applies the translated string.
   */
  function updateDOM() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var translated = t(key);

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.getAttribute('data-i18n-attr') === 'placeholder') {
          el.placeholder = translated;
        } else {
          el.value = translated;
        }
      } else if (el.tagName === 'OPTION') {
        el.textContent = translated;
      } else {
        el.textContent = translated;
      }
    });

    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  /**
   * Initialises i18n: loads the saved language preference, applies translations.
   */
  async function initialize() {
    var lang = 'en';
    try {
      if (window.vault && window.vault.getSettings) {
        var settings = await window.vault.getSettings();
        if (settings && settings.language) lang = settings.language;
      }
    } catch (e) { /* use default */ }
    if (!TRANSLATIONS[lang]) lang = 'en';
    _currentLang = lang;
    _translations = TRANSLATIONS[lang] || TRANSLATIONS.en;
    document.documentElement.lang = _currentLang;
    updateDOM();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  function _get(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return (o && o[k] !== undefined) ? o[k] : undefined;
    }, obj);
  }

  return { t: t, setLanguage: setLanguage, getCurrentLanguage: getCurrentLanguage, getTranslations: getTranslations, updateDOM: updateDOM, initialize: initialize };
})();
