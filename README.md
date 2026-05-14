# MADROS 3D konfigurátor

Statický frontend konfigurátoru pro web. Lokálně se vyvíjí přes webpack dev server, pro nahrání na web se generuje hotová složka `dist`.

## Lokální spuštění

```bash
npm install
npm run dev
```

Výchozí dev server běží na `http://localhost:8080/`.

## Produkční export pro web

```bash
npm ci
npm run build:static
```

Výsledná složka `dist` obsahuje:

- `index.html`
- `bundle.js`
- všechny potřebné statické assety z `public`
- `.nojekyll` pro GitHub Pages

Složku `dist` lze nahrát na běžný statický hosting. Pro rychlou kontrolu:

```bash
npm run serve:dist
```

## GitHub Pages

Repozitář obsahuje workflow `.github/workflows/pages.yml`. Po pushnutí do větve `main` GitHub automaticky:

1. nainstaluje závislosti,
2. spustí `npm run build:static`,
3. nasadí obsah složky `dist` na GitHub Pages.

V GitHub repozitáři je potřeba zapnout Pages přes **Settings -> Pages -> Source: GitHub Actions**.

## Velké assety

Do GitHubu nepatří pracovní zdrojové soubory typu `.blend`, `.zip`, `.tiff`, `.obj` atd. Jsou vynechané v `.gitignore` a produkční export je také nekopíruje do `dist`.

Pokud bude repozitář i po vynechání pracovních souborů příliš velký, dejte velké modely/textury do Git LFS nebo na externí asset hosting.

## PDF a odesílání poptávky

Samotný konfigurátor funguje jako statický web. Funkce pro serverové PDF a odeslání poptávky potřebují Node server:

```bash
npm run pdf-server
```

Proměnné pro e-mail jsou v `.env.example`. Soubor `.env` se nesmí commitovat do GitHubu.
