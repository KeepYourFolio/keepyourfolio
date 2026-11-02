/* KYF Mobile : lecture de relevés PDF (parseurs repris du Convertisseur Keep Your Folio). Tout reste sur le téléphone. */
(function(){"use strict";
  function _bankReconstructLines(elements) {
    // Regroupe les éléments PDF.js par page + position verticale (tolérance
    // quelques px) pour reformer les lignes de texte telles qu'affichées.
    // Conserve la position x de chaque fragment (offsets) pour pouvoir,
    // ensuite, situer un montant sous la colonne Débit ou Crédit.
    const byPage = {};
    elements.forEach(e => { (byPage[e.page] = byPage[e.page] || []).push(e); });
    const lines = [];
    Object.keys(byPage).forEach(p => {
      const els = byPage[p].slice().sort((a, b) => a.yTop - b.yTop || a.x - b.x);
      let current = null;
      els.forEach(e => {
        if (current && Math.abs(e.yTop - current.yTop) <= 3) {
          current.parts.push(e);
        } else {
          current = { yTop: e.yTop, page: e.page, parts: [e] };
          lines.push(current);
        }
      });
    });
    return lines.map(l => {
      const parts = l.parts.sort((a, b) => a.x - b.x);
      let text = '';
      const offsets = [];
      parts.forEach((part, idx) => {
        if (idx > 0) {
          const prev = parts[idx - 1];
          const gap = part.x - (prev.x + (prev.width || 0));
          // Écart quasi nul = fragments visuellement collés (souvent un
          // caractère accentué séparé en glyphe propre, ex: "CH"+"È"+"QUE")
          // - on les recolle sans espace. Un vrai écart garde l'espace.
          if (gap > 0.5) text += ' ';
        }
        offsets.push({ start: text.length, end: text.length + part.text.length, x: part.x, width: part.width || 0 });
        text += part.text;
      });
      return { text, offsets, page: l.page };
    });
  }
  const MOIS_SAXO = {jan:1,feb:2,mar:3,apr:4,mai:5,may:5,jun:6,jul:7,aug:8,okt:10,oct:10,nov:11,dez:12,dec:12,sep:9};
  function parseSaxoDate(str) {
    const m = str.match(/(\d{2})-([A-Za-zäöü]{3})-(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/);
    if (!m) return null;
    const mois = MOIS_SAXO[m[2].toLowerCase()];
    if (!mois) return null;
    return { date: `${m[1]}/${String(mois).padStart(2,'0')}/${m[3]}`, heure: m[4]||'' };
  }
  // Robuste à deux formats numériques rencontrés dans les vrais documents Saxo :
  // standard EN/DE (point=milliers, virgule=décimale, ex. "5.480,43") ET une
  // variante suisse (point=décimale, avec ou sans apostrophe-milliers, ex.
  // "19.50" ou "16'997.84") - détecté par l'absence de virgule.
  function parseSaxoNum(s) {
    s = String(s).trim();
    if (s.includes('.') && !s.includes(',')) return parseFloat(s.replace(/'/g, ''));
    return parseFloat(s.replace(/\./g,'').replace(',', '.'));
  }

  // Trouve la ligne de détail (identifiant numérique long suivi directement
  // d'une date ou d'un tiret) et prend la DERNIÈRE date de cette ligne
  // toujours la date de paiement (Pay Date/Zahltag/Posting Date), quel que
  // soit le nombre de dates présentes (certaines colonnes sont parfois "-").
  // Ne pas se fier à "Reporting period" en haut du document : il peut couvrir
  // plusieurs jours (ex. "11-Jul-2025 - 17-Jul-2025"), la date réelle de
  // l'opération est ailleurs.
  function lastDateOfDetailRow(text) {
    const line = text.split(/\r?\n/).find(l => /\d{6,}\s+(?:\d{2}-[A-Za-zäöü]{3}-\d{4}|-)/.test(l));
    if (!line) return null;
    const dates = [...line.matchAll(/\d{2}-[A-Za-zäöü]{3}-\d{4}/g)];
    return dates.length ? parseSaxoDate(dates[dates.length - 1][0] + ' 00:00') : null;
  }

  // ── Corporate Action (dividendes, avec retenue à la source) - étape 3.
  function parseSaxoCorporateAction(text) {
    const isin = (text.match(/ISIN\s+([A-Z]{2}[A-Z0-9]{9}\d)/) || [])[1] || '';
    const dateInfo = lastDateOfDetailRow(text);
    const descMatch = text.match(/Description\s+(.+?)\s+(?:Dividend per share|Dividende pro Aktie)/);
    const nom = descMatch ? descMatch[1].trim() : '';
    const netMatch = text.match(/(?:Net Amount|Nettobetrag)[\s\S]*?(-?[\d.,]+)\s*$/m);
    const montant = netMatch ? parseSaxoNum(netMatch[1]) : 0;
    if (!isin || !dateInfo) return null;
    return { date: dateInfo.date, libelle: `Dividende ${nom}`.trim(), debit: montant<0?Math.abs(montant):'', credit: montant>=0?montant:'' };
  }

  // ── Cash Amount (intérêts) - étape 3.
  function parseSaxoCashAmount(text) {
    const dateInfo = lastDateOfDetailRow(text);
    const netMatch = text.match(/(?:Net Amount|Nettobetrag)[\s\S]*?(-?[\d.,]+)\s*$/m);
    const montant = netMatch ? parseSaxoNum(netMatch[1]) : 0;
    if (!dateInfo) return null;
    return { date: dateInfo.date, libelle: 'Intérêts Saxo Bank', debit: montant<0?Math.abs(montant):'', credit: montant>=0?montant:'' };
  }

  function parseSaxoTradeSimple(text) {
    const isin = (text.match(/ISIN\s+([A-Z]{2}[A-Z0-9]{9}\d)/) || [])[1] || '';
    if (!isin) return null;
    // Nom : uniquement le segment entre le type de titre (ETF/Bond/Aktie/
    // Anleihe, toujours juste avant "Instrument") et "ISIN" - jamais depuis
    // le début du document, qui contiendrait sinon l'en-tête de page entier
    // (adresse Saxo Bank, "Trade Details Report", dates de génération...).
    // Nettoyé des libellés/dates de colonne de droite qui s'intercalent dans
    // le texte linéarisé (mise en page à 2 colonnes) - best-effort, comme
    // partout ailleurs dans l'outil, à corriger à la main si besoin.
    const typeHeaderMatch = text.match(/^(ETF|Bond|Aktie|Anleihe)\s*$/m);
    const segmentStart = typeHeaderMatch ? typeHeaderMatch.index + typeHeaderMatch[0].length : 0;
    const isinIdx = text.search(/ISIN\s+[A-Z]{2}[A-Z0-9]{9}\d/);
    const beforeIsin = text.slice(segmentStart, isinIdx > -1 ? isinIdx : undefined);
    const nom = beforeIsin
      .replace(/Instrument\s*/,'')
      .replace(/(Trade time|Handelszeit)\s+\d{2}-[A-Za-zäöü]{3}-\d{4}\s+\d{2}:\d{2}(:\d{2})?/,'')
      .replace(/\s+/g,' ').trim();
    const bsMatch = text.match(/(?:B\/S|K\/V)\s+(Buy|Sell|Kauf|Verkauf)/);
    const type = bsMatch && /Buy|Kauf/.test(bsMatch[1]) ? 'achat' : 'vente';
    const qtyMatch = text.match(/(?:Quantity|Menge)\s+(-?[\d.,]+)/);
    const qty = qtyMatch ? Math.abs(parseSaxoNum(qtyMatch[1])) : 0;
    const priceMatch = text.match(/(?:Price|Preis)\s+([\d.,]+)\s*([A-Z]{3})/);
    const prix = priceMatch ? parseSaxoNum(priceMatch[1]) : 0;
    const devise = priceMatch ? priceMatch[2] : '';
    const dateMatch = text.match(/(?:Trade time|Handelszeit)\s+(\d{2}-[A-Za-zäöü]{3}-\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/);
    const dateInfo = dateMatch ? parseSaxoDate(dateMatch[1]) : null;
    const netMatch = text.match(/(?:Net Amount|Nettobetrag)[\s\S]*?(-?[\d.,]+)\s*$/m);
    const montant = netMatch ? Math.abs(parseSaxoNum(netMatch[1])) : 0;
    return { date: dateInfo ? dateInfo.date : '', type, isin, nom, qty, prix, devise, montant };
  }

  function parseSaxoCashTransfer(text) {
    // Même principe que pour les Trade Details : le dernier montant de la
    // ligne (Booked Amount/Gebuchter Betrag) est toujours le montant final
    // déjà converti dans la devise du compte, avec ou sans conversion.
    const lineMatch = text.split(/\r?\n/).find(l => /(Einlage|Deposit|Auszahlung|Withdrawal)\s+\d{5,}/.test(l) && /\d{2}-[A-Za-zäöü]{3}-\d{4}/.test(l));
    if (!lineMatch) return null;
    const isDeposit = /Einlage|Deposit/.test(lineMatch);
    const dateM = lineMatch.match(/(\d{2}-[A-Za-zäöü]{3}-\d{4})/);
    const dateInfo = dateM ? parseSaxoDate(dateM[1] + ' 00:00') : null;
    const nums = lineMatch.match(/-?[\d.]+,\d{2}(?!\d)/g) || [];
    if (!nums.length || !dateInfo) return null;
    const montant = Math.abs(parseSaxoNum(nums[nums.length - 1]));
    return { date: dateInfo.date, libelle: isDeposit ? 'Dépôt Saxo Bank' : 'Retrait Saxo Bank', debit: isDeposit ? '' : montant, credit: isDeposit ? montant : '' };
  }

  function parseSaxoKontoauszug(text) {
    const rows = [];
    const lineRe = /(\d{2}-[A-Za-zäöü]{3}-\d{4})\s+\d{2}-[A-Za-zäöü]{3}-\d{4}\s+([A-Z]+)\s*\([^)]*\)\s+([\d.,]+)\s+([\d.,]+)/g;
    let m;
    while ((m = lineRe.exec(text))) {
      const dateInfo = parseSaxoDate(m[1] + ' 00:00');
      rows.push({ date: dateInfo.date, libelle: m[2] === 'DEPOSIT' ? 'Dépôt Saxo Bank' : m[2], debit: '', credit: parseSaxoNum(m[3]) });
    }
    return rows;
  }

  // Routeur : détecte la marque et le type de document.
  // ── DEGIRO - Aperçu des transactions (français) ──────────────────────
  // Table large où le nombre de colonnes varie ligne à ligne (le taux de
  // change et les frais de courtage disparaissent silencieusement, sans
  // case vide, quand ils ne s'appliquent pas - pas de comptage de position
  // fixe possible). Ancrage sur ce qui est TOUJOURS présent : date/heure en
  // tête de ligne, ISIN juste après le nom du produit, puis Place/Lieu/
  // Quantité/Cours/devise dans cet ordre fixe juste après l'ISIN, et enfin
  // les 2 DERNIERS tokens de la ligne = Montant négocié + sa devise (déjà
  // net de frais, dans la devise du compte). Testé sur un vrai relevé réel
  // de 15 pages (240 transactions, 2010-2022).
  // Un nom de produit trop long est coupé sur la ou les lignes suivantes par
  // la mise en page PDF (ex. "CROWDSTRIKE HOLDINGS" puis "INC - A" juste en
  // dessous, parfois 3-4 lignes) - rattaché tant que la ligne suivante n'est
  // ni une nouvelle transaction datée ni du texte de mise en page (en-tête
  // répété, pied de page flatexDEGIRO, numéro de page).
  function parseDegiroNum(s) { return parseFloat(String(s).trim().replace(/\s/g,'').replace(',', '.')); }
  function parseDegiroTransactions(text) {
    const dateRe = /^(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/;
    const isinRe = /([A-Z]{2}[A-Z0-9]{9}\d)/;
    const isNoise = l => !l.trim() || /^(Date\s+Heure|flatex|Amstelplein|1096 HA|Dutch Branch|Bank AG|Page\s+\d+\s*\/\s*\d+)/i.test(l.trim());
    const transactions = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const dm = lines[i].match(dateRe);
      if (!dm) continue;
      const rest = dm[3];
      const isinMatch = rest.match(isinRe);
      if (!isinMatch) continue;
      const produit = rest.slice(0, isinMatch.index).trim();
      const isin = isinMatch[1];
      const afterIsin = rest.slice(isinMatch.index + isin.length).trim();
      const tokens = afterIsin.split(/\s+/);
      if (tokens.length < 7) continue;
      const qty = parseDegiroNum(tokens[2]);
      const cours = parseDegiroNum(tokens[3]);
      const coursDevise = tokens[4];
      const montantNego = parseDegiroNum(tokens[tokens.length - 2]);
      const montantNegoDevise = tokens[tokens.length - 1];
      if (isNaN(qty) || isNaN(cours) || isNaN(montantNego)) continue;
      let j = i + 1, suffix = '';
      while (j < lines.length && !dateRe.test(lines[j]) && !isNoise(lines[j])) {
        suffix += ' ' + lines[j].trim();
        j++;
      }
      i = j - 1;
      transactions.push({
        date: dm[1].replace(/-/g, '/'),
        type: qty >= 0 ? 'achat' : 'vente',
        isin, nom: (produit + suffix).trim(),
        qty: Math.abs(qty), prix: cours, devise: coursDevise,
        montant: Math.abs(montantNego), montantDevise: montantNegoDevise
      });
    }
    return transactions;
  }

  // Format anglais du relevé de compte : virgule=milliers, point=décimale.
  function parseDegiroNumEN(s) { return parseFloat(String(s).replace(/,/g, '')); }
  // Format du "Dividend note" : virgule=décimale (comme les autres documents FR/DE de ce lot).
  function parseDegiroNumFR(s) { return parseFloat(String(s).replace(',', '.')); }

  // ── DEGIRO Account statement (relevé de compte, ledger avec solde courant) ──
  // Un seul événement économique peut s'étaler sur plusieurs lignes (un
  // dividende étranger = ligne Dividend + ligne Dividend Tax + lignes FX de
  // conversion séparées). Les lignes "FX Debit"/"FX Credit" et "DEGIRO
  // Transaction Fee" sont la mécanique interne de conversion/frais, pas un
  // événement à afficher isolément - ignorées ici (déjà reflétées dans le
  // montant net du dividende ou de l'achat/vente lui-même). Ancrage sur les
  // 4 DERNIERS tokens de chaque ligne (devise Change, Change, devise Solde,
  // Solde), toujours présents quel que soit ce qui précède.
  function parseDegiroAccountStatement(text) {
    const lines = text.split(/\r?\n/);
    const dateRe = /^(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(\d{2}-\d{2}-\d{4})\s+(.+)$/;
    const isinRe = /([A-Z]{2}[A-Z0-9]{9}\d)/;
    const transactions = [], mouvements = [];
    function lastFour(tokens) {
      const n = tokens.length;
      return { changeDevise: tokens[n-4], change: parseDegiroNumEN(tokens[n-3]), soldeDevise: tokens[n-2], solde: parseDegiroNumEN(tokens[n-1]) };
    }
    for (let i = 0; i < lines.length; i++) {
      const dm = lines[i].match(dateRe);
      if (!dm) continue;
      const date = dm[1].replace(/-/g, '/');
      const rest = dm[4].trim();
      const tokens = rest.split(/\s+/);
      if (tokens.length < 4) continue;
      const { changeDevise, change } = lastFour(tokens);

      if (/FX Debit|FX Credit|DEGIRO Transaction Fee/.test(rest)) continue;

      if (/\bBuy\b|\bSell\b/.test(rest)) {
        const isinMatch = rest.match(isinRe);
        const tm = rest.match(/(Buy|Sell)\s+(-?[\d.,]+)\s+.+?@([\d.,]+)\s+([A-Z]{3})/);
        if (isinMatch && tm) {
          const nom = rest.slice(0, isinMatch.index).trim();
          transactions.push({
            date, type: tm[1] === 'Buy' ? 'achat' : 'vente', isin: isinMatch[1], nom,
            qty: Math.abs(parseDegiroNumEN(tm[2])), prix: parseDegiroNumEN(tm[3]), devise: tm[4],
            montant: Math.abs(change), montantDevise: changeDevise
          });
        }
        continue;
      }

      if (/Dividend Tax/.test(rest)) continue; // rattachée à la ligne Dividend juste avant, jamais seule

      if (/\bDividend\b/.test(rest)) {
        const isinMatch = rest.match(isinRe);
        const nom = isinMatch ? rest.slice(0, isinMatch.index).trim() : '';
        let net = change;
        const nextDm = lines[i+1] ? lines[i+1].match(dateRe) : null;
        if (nextDm) {
          const nextRest = nextDm[4].trim();
          const nextIsin = nextRest.match(isinRe);
          if (/Dividend Tax/.test(nextRest) && nextIsin && isinMatch && nextIsin[1] === isinMatch[1]) {
            net += lastFour(nextRest.split(/\s+/)).change;
          }
        }
        mouvements.push({ date, libelle: `Dividende ${nom}`.trim(), debit: net<0?Math.abs(net):'', credit: net>=0?net:'' });
        continue;
      }

      if (/\bInterest\b/.test(rest)) {
        mouvements.push({ date, libelle: 'Intérêts DEGIRO', debit: change<0?Math.abs(change):'', credit: change>=0?change:'' });
        continue;
      }

      // Toute autre ligne datée avec un Change (dépôt/retrait, autre frais non
      // catégorisé) : mouvement générique, jamais ignoré silencieusement.
      const nom = rest.replace(isinRe, '').trim();
      mouvements.push({ date, libelle: nom || 'Mouvement DEGIRO', debit: change<0?Math.abs(change):'', credit: change>=0?change:'' });
    }
    return { transactions, mouvements };
  }

  // ── DEGIRO Dividend note (confirmation de dividende isolée) ─────────────
  function parseDegiroDividendNote(text) {
    const isin = (text.match(/Security ISIN:\s*([A-Z]{2}[A-Z0-9]{9}\d)/) || [])[1] || '';
    const nom = (text.match(/Security name:\s*(.+)/) || [])[1] || '';
    const dateMatch = text.match(/Dividend date \(Pay date\):\s*(\d{4})-(\d{2})-(\d{2})/);
    const date = dateMatch ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}` : '';
    const rowMatch = text.match(/(\d+)\s+([\d.,]+)\s+([\d.,]+)\s+(-?[\d.,]+)\s+([\d.,]+)\s+([A-Z]{3})/);
    if (!isin || !date || !rowMatch) return null;
    const net = parseDegiroNumFR(rowMatch[5]);
    return { transactions: [], mouvements: [{ date, libelle: `Dividende ${nom}`.trim(), debit: '', credit: net }] };
  }

  // ── HelloBank (BNP Paribas Austria) ──────────────────────────────────
  // Format allemand : point=milliers, virgule=décimale, ",--" = ",00" pour
  // un montant rond. "Zu Lasten" (achat, débité) / "Zu Gunsten" (vente ou
  // dividende, crédité) donne toujours le montant final net en EUR, quel
  // que soit le nombre de lignes de frais qui précèdent, même principe
  // d'ancrage que Saxo/DEGIRO. Un transfert de titres entrant ("Freier
  // Erhalt") n'a aucun mouvement d'espèces : le PRU est reconstitué depuis
  // le prix de revient fiscal donné (steuerlicher Anschaffungswert / qty).
  function parseHelloBankNum(s) {
    s = String(s).trim();
    if (/,--$/.test(s)) s = s.replace(/,--$/, ',00');
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  function parseHelloBankDate(d, m, y) {
    return String(d).padStart(2,'0') + '/' + String(m).padStart(2,'0') + '/' + y;
  }
  function extractHelloBankTitel(text) {
    const m = text.match(/Titel:\s*([A-Z]{2}[A-Z0-9]{9}\d)\s+(.+)/);
    if (!m) return null;
    const isin = m[1];
    let nom = m[2].trim();
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex(function(l){ return l.includes('Titel:') && l.includes(isin); });
    if (idx > -1 && lines[idx+1] && !/^(Kurs:|Dividende:|Lieferpflichtiger:|Verwahrart:|Handelsplatz:)/.test(lines[idx+1].trim())) {
      nom += ' ' + lines[idx+1].trim();
    }
    return { isin: isin, nom: nom.replace(/\s+/g,' ').trim() };
  }
  function parseHelloBankTrade(text) {
    const titel = extractHelloBankTitel(text);
    if (!titel) return null;
    const isBuy = /Geschäftsart:\s*Kauf/.test(text);
    const qtyMatch = text.match(/(?:Zugang|Abgang):\s*([\d.]+)\s*Stk/);
    const qty = qtyMatch ? parseHelloBankNum(qtyMatch[1]) : 0;
    const priceMatch = text.match(/Kurs:\s*([\d.,]+(?:,--)?)\s*([A-Z]{3})/);
    const prix = priceMatch ? parseHelloBankNum(priceMatch[1]) : 0;
    const devise = priceMatch ? priceMatch[2] : '';
    const dateMatch = text.match(/Handelszeit:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const date = dateMatch ? parseHelloBankDate(dateMatch[1], dateMatch[2], dateMatch[3]) : '';
    const montantMatch = text.match(/Zu (?:Lasten|Gunsten) IBAN\s+.+?\s+(-?[\d.,]+(?:,--)?)\s*EUR/);
    const montant = montantMatch ? Math.abs(parseHelloBankNum(montantMatch[1])) : 0;
    if (!date || !qty || !montant) return null;
    return { date: date, type: isBuy ? 'achat' : 'vente', isin: titel.isin, nom: titel.nom, qty: qty, prix: prix, devise: devise, montant: montant, montantDevise: 'EUR' };
  }
  function parseHelloBankDividende(text) {
    const titel = extractHelloBankTitel(text);
    if (!titel) return null;
    const dateMatch = text.match(/Valuta\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const date = dateMatch ? parseHelloBankDate(dateMatch[1], dateMatch[2], dateMatch[3]) : '';
    const montantMatch = text.match(/Zu Gunsten IBAN\s+.+?\s+(-?[\d.,]+(?:,--)?)\s*EUR/);
    const montant = montantMatch ? parseHelloBankNum(montantMatch[1]) : 0;
    if (!date || !montant) return null;
    return { date: date, libelle: ('Dividende ' + titel.nom).trim(), debit: montant<0?Math.abs(montant):'', credit: montant>=0?montant:'' };
  }
  function parseHelloBankInboundDelivery(text) {
    const titel = extractHelloBankTitel(text);
    if (!titel) return null;
    const qtyMatch = text.match(/Zugang:\s*([\d.]+)\s*Stk/);
    const qty = qtyMatch ? parseHelloBankNum(qtyMatch[1]) : 0;
    const dateMatch = text.match(/Kassatag:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const date = dateMatch ? parseHelloBankDate(dateMatch[1], dateMatch[2], dateMatch[3]) : '';
    const valMatch = text.match(/steuerlicher Anschaffungswert:\s*([\d.,]+(?:,--)?)\s*EUR/);
    const valTotal = valMatch ? parseHelloBankNum(valMatch[1]) : 0;
    if (!date || !qty) return null;
    return { date: date, type: 'achat', isin: titel.isin, nom: titel.nom, qty: qty, prix: qty ? valTotal/qty : 0, devise: 'EUR', montant: valTotal, montantDevise: 'EUR' };
  }

  // ── Interactive Brokers (Flex Query, XML) ────────────────────────────
  // Contrairement aux 4 autres courtiers (texte extrait d'un PDF), un
  // export Flex Query IBKR est du XML structuré avec des attributs nommés
  // (Trade, CashTransaction...) - traité avec le DOMParser natif du
  // navigateur plutôt qu'à coup de regex sur du texte, bien plus fiable
  // pour du XML. Le format de date de l'attribut dateTime est incohérent
  // selon les exports ("2013-01-03", "20180312;202000" ou "20230404")
  // repli sur reportDate (mêmes formats possibles) si dateTime est absent,
  // rencontré sur de vrais échantillons réels.
  function parseIBKRDate(raw) {
    if (!raw) return '';
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    return '';
  }
  function mapIBKRTrade(attr) {
    const buySell = attr.buySell;
    const isin = attr.isin || attr.symbol || '';
    const nom = attr.description || attr.symbol || '';
    const qty = Math.abs(parseFloat(attr.quantity));
    const prix = parseFloat(attr.tradePrice);
    const devise = attr.currency;
    const date = parseIBKRDate(attr.tradeDate);
    const montant = Math.abs(parseFloat(attr.cost));
    if (!buySell || !qty || isNaN(prix) || !date) return null;
    return { date: date, type: buySell === 'BUY' ? 'achat' : 'vente', isin: isin, nom: nom, qty: qty, prix: prix, devise: devise, montant: montant, montantDevise: devise };
  }
  function mapIBKRCashTransaction(attr) {
    const type = attr.type;
    const amount = parseFloat(attr.amount);
    const date = parseIBKRDate(attr.dateTime) || parseIBKRDate(attr.reportDate);
    const description = attr.description || '';
    if (isNaN(amount) || !date) return null;
    let libelle;
    if (type === 'Dividends') libelle = 'Dividende ' + description;
    else if (type === 'Withholding Tax') libelle = 'Retenue à la source ' + description;
    else if (type === 'Deposits/Withdrawals') libelle = description || 'Dépôt/Retrait Interactive Brokers';
    else if (type === 'Broker Interest Received' || type === 'Broker Interest Paid') libelle = 'Intérêts Interactive Brokers';
    else if (type === 'Other Fees') libelle = 'Frais ' + description;
    else libelle = description || type || 'Mouvement Interactive Brokers';
    return { date: date, libelle: libelle.trim(), debit: amount<0?Math.abs(amount):'', credit: amount>=0?amount:'' };
  }
  function elAttrs(el) {
    const o = {};
    for (let i = 0; i < el.attributes.length; i++) o[el.attributes[i].name] = el.attributes[i].value;
    return o;
  }
  function parseIBKRDocument(text) {
    if (!/<FlexQueryResponse/.test(text)) return null;
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); } catch (e) { return null; }
    if (doc.querySelector('parsererror')) return null;
    const transactions = [], mouvements = [];
    doc.querySelectorAll('Trade').forEach(function(el){ const t = mapIBKRTrade(elAttrs(el)); if (t) transactions.push(t); });
    doc.querySelectorAll('CashTransaction').forEach(function(el){ const m = mapIBKRCashTransaction(elAttrs(el)); if (m) mouvements.push(m); });
    return { transactions: transactions, mouvements: mouvements };
  }

  // ── N26 (relevé de compte mensuel) ───────────────────────────────────
  // Le document contient AUSSI des sections "Zusammenfassung"/"Übersicht
  // zu Gebühren und Zinsen" qui RÉPÈTENT les mêmes montants sans date
  // complète - jamais scannées, sinon double comptage. Ancrage strict
  // entre l'en-tête de colonnes réel et le premier pied de page.
  // Zinsertrag (intérêt brut) + Abgeltungssteuer + Solidaritätszuschlag
  // (impôts, parfois absents certains mois, ex. Kontoauszug06/07 sans
  // taxe) forment UN SEUL mouvement net, jamais 3 lignes séparées.
  // Testé et exact contre le test officiel Portfolio Performance
  // (intérêt net 185.66 EUR, dépôt 5000.00 EUR, retrait "An Hauptkonto"
  // 100.00 EUR). Le retrait n'a pas de mot-clé dédié, c'est un virement
  // interne (An Hauptkonto = vers le compte principal, montant négatif),
  // capturé par le même repli générique que le dépôt (Von Hauptkonto),
  // aucun cas particulier nécessaire.
  function parseN26Num(s) { return parseFloat(String(s).replace(/\./g,'').replace(',', '.')); }
  function parseN26Kontoauszug(text) {
    const startMarker = 'Beschreibung Verbuchungsdatum Betrag';
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return null;
    const afterStart = text.slice(startIdx + startMarker.length);
    const endIdx = afterStart.search(/Kontotyp:|N26 Bank AG \|/);
    const section = endIdx > -1 ? afterStart.slice(0, endIdx) : afterStart;
    const lineRe = /^(.+?)\s+(\d{2})\.(\d{2})\.(\d{4})\s+([+-][\d.,]+)€/;
    const mouvements = [];
    let interestGroup = null;
    function finalizeInterest(g) {
      const net = g.gross - g.tax;
      return { date: g.date, libelle: 'Intérêts N26', debit: net<0?Math.abs(net):'', credit: net>=0?net:'' };
    }
    section.split(/\r?\n/).forEach(function(line){
      const m = line.trim().match(lineRe);
      if (!m) return;
      const label = m[1].trim();
      const date = m[2] + '/' + m[3] + '/' + m[4];
      const amount = parseN26Num(m[5]);
      if (label === 'Zinsertrag') {
        if (interestGroup) mouvements.push(finalizeInterest(interestGroup));
        interestGroup = { date: date, gross: amount, tax: 0 };
        return;
      }
      if (label === 'Abgeltungssteuer' || label === 'Solidaritätszuschlag') {
        if (interestGroup) interestGroup.tax += Math.abs(amount);
        return;
      }
      if (interestGroup) { mouvements.push(finalizeInterest(interestGroup)); interestGroup = null; }
      mouvements.push({ date: date, libelle: label, debit: amount<0?Math.abs(amount):'', credit: amount>=0?amount:'' });
    });
    if (interestGroup) mouvements.push(finalizeInterest(interestGroup));
    return { transactions: [], mouvements: mouvements };
  }
  function parseN26Document(text) {
    if (!/N26 Bank AG/.test(text)) return null;
    // Le titre du document varie ("Kontoauszug", "Vorläufiger Kontoauszug"),
    // le vrai marqueur fiable est l'en-tête de la table de mouvements
    // elle-même, celui dont parseN26Kontoauszug se sert pour scoper sa
    // lecture.
    if (/Beschreibung Verbuchungsdatum Betrag/.test(text)) return parseN26Kontoauszug(text);
    return { transactions: [], mouvements: [] };
  }

  // ── Boursorama / BoursoBank ────────────────────────────────────────
  // 3 formats de document distincts pour un même courtier : "ACHAT/VENTE
  // COMPTANT" (actions/ETF, France ou étranger avec conversion de devise
  // "ACHAT/VENTE DEVISES A TERME"), "OPERATION SUR OPC" (rachat SICAV/
  // F.C.P., structure différente avec "Valeur liquidative" au lieu de
  // "Cours exécuté"), et "COUPONS REMBOURSEMENTS" (relevé MENSUEL de
  // dividendes, plusieurs lignes/titres dans un seul document, pas un
  // fichier par dividende). Le montant net final ("Montant net au débit/
  // crédit de votre compte") est tantôt en fin d'une rangée d'en-têtes à
  // plusieurs colonnes (valeurs sur la ligne suivante), tantôt seul sur sa
  // ligne avec sa valeur juste en dessous - toujours le DERNIER nombre de
  // la ligne pertinente, jamais le premier. Testé et exact contre 10 vrais
  // documents (2 vérifiés au centime contre le test officiel Portfolio
  // Performance : 2008,64 EUR achat France, 195,13 EUR achat étranger).
  function parseBoursoNum(s) { return parseFloat(String(s).replace(/\s/g,'').replace(',', '.')); }
  function extractBoursoMontant(text) {
    const lines = text.split(/\r?\n/);
    const labelIdx = lines.findIndex(function(l){ return /Montant net au (?:débit|crédit) de votre compte/.test(l); });
    if (labelIdx === -1) return null;
    const labelLine = lines[labelIdx];
    const parts = labelLine.split(/Montant net au (?:débit|crédit) de votre compte/);
    const afterLabel = parts[1] || '';
    const searchLine = afterLabel.trim() ? afterLabel : (lines[labelIdx+1] || '');
    const nums = searchLine.match(/-?[\d\s]*[\d],\d{2}\s*EUR/g);
    if (!nums || !nums.length) return null;
    const m = nums[nums.length - 1].match(/(-?[\d\s]*[\d],\d{2})/);
    return m ? parseBoursoNum(m[1]) : null;
  }
  function parseBoursoTrade(text) {
    const isBuy = /ACHAT COMPTANT/.test(text);
    const isSell = /VENTE COMPTANT/.test(text) || /REPRISE (SICAV|F\.C\.P\.)/.test(text);
    if (!isBuy && !isSell) return null;
    const isinMatch = text.match(/Code ISIN\s*:\s*([A-Z]{2}[A-Z0-9]{9}\d)/);
    if (!isinMatch) return null;
    const isin = isinMatch[1];
    const priceMatch = text.match(/(?:Cours exécuté|Valeur liquidative)\s*:\s*([\d\s.,]+)\s*([A-Z]{3})/);
    const prix = priceMatch ? parseBoursoNum(priceMatch[1]) : 0;
    const devise = priceMatch ? priceMatch[2] : '';
    const lines = text.split(/\r?\n/);
    const dateLine = lines.find(function(l){ return /^\d{2}\/\d{2}\/\d{4}\s+[\d.,]+\s+\S/.test(l.trim()); });
    if (!dateLine) return null;
    const dm = dateLine.trim().match(/^(\d{2}\/\d{2}\/\d{4})\s+([\d.,]+)\s+(.+?)(?:\s+Référence\s*:.*)?$/);
    if (!dm) return null;
    const montant = extractBoursoMontant(text);
    if (montant == null) return null;
    return { date: dm[1], type: isBuy ? 'achat' : 'vente', isin: isin, nom: dm[3].trim(), qty: parseBoursoNum(dm[2]), prix: prix, devise: devise, montant: montant, montantDevise: 'EUR' };
  }
  function parseBoursoDividendes(text) {
    if (!/COUPONS REMBOURSEMENTS/.test(text)) return null;
    const startIdx = text.indexOf('DETAIL COUPONS');
    const endIdx = text.indexOf('TOTAL EUR');
    if (startIdx === -1 || endIdx === -1) return [];
    const section = text.slice(startIdx, endIdx);
    const rowRe = /^(\d{2}\/\d{2}\/\d{4})\s+([\d.,]+)\s+(.+?)\s+\(([A-Z]{2}[A-Z0-9]{9}\d)\)\s+(.+)$/;
    const mouvements = [];
    section.split(/\r?\n/).forEach(function(line){
      const m = line.trim().match(rowRe);
      if (!m) return;
      const nums = m[5].match(/-?[\d\s]*[\d],\d{2}/g);
      if (!nums || !nums.length) return;
      const net = parseBoursoNum(nums[nums.length - 1]);
      mouvements.push({ date: m[1], libelle: 'Dividende ' + m[3].trim(), debit: net<0?Math.abs(net):'', credit: net>=0?net:'' });
    });
    return mouvements;
  }
  function parseBoursoDocument(text) {
    const isTrade = /OPERATION DE BOURSE|OPERATION SUR OPC/.test(text);
    const isDividende = /COUPONS REMBOURSEMENTS/.test(text);
    if (!isTrade && !isDividende) return null;
    const transactions = [], mouvements = [];
    if (isDividende) {
      const d = parseBoursoDividendes(text);
      if (d) mouvements.push.apply(mouvements, d);
    } else {
      const t = parseBoursoTrade(text);
      if (t) transactions.push(t);
    }
    return { transactions: transactions, mouvements: mouvements };
  }

  // ── Revolut - Trade Confirmation (achat/vente unitaire) ──────────────
  // Étape 1 seule : les "Trade Confirmation" simples (une opération par
  // document). Le relevé de compte multi-opérations (AccountStatementXX,
  // qui mélange achats/ventes/dépôts/frais/dividendes dans un même
  // document, avec un croisement entre section transactions et section
  // portefeuille pour retrouver l'ISIN des titres encore détenus) est
  // volontairement pas encore construit, nettement plus complexe, prévu
  // dans une étape séparée.
  // Deux tableaux dans le document : "Order details" (avec ISIN, quantité
  // arrondie, date de règlement, utilisé ici) et "Execution details" (sans
  // ISIN, quantité précise à 10 décimales, parfois plusieurs lignes en cas
  // d'exécutions fractionnées, jamais utilisé). Le dernier montant en
  // devise avant la date de règlement sur la ligne de données est toujours
  // le montant total (le libellé de colonne varie entre "Total Amount"
  // pour un achat et juste "Price" pour une vente, mais la position est
  // fiable dans les deux cas). Testé et exact contre le test officiel
  // Portfolio Performance (100.00 EUR achat, 1166.12 USD vente).
  const REVOLUT_MOIS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const REVOLUT_DEVISE_SYMBOLE = {'€':'EUR','$':'USD','£':'GBP'};
  function parseRevolutDate(str) {
    const m = str.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (!m) return '';
    const mois = REVOLUT_MOIS[m[2].toLowerCase()];
    if (!mois) return '';
    return String(m[1]).padStart(2,'0') + '/' + String(mois).padStart(2,'0') + '/' + m[3];
  }
  function parseRevolutNum(s) { return parseFloat(String(s).replace(/,/g,'')); }
  function parseRevolutTrade(text) {
    if (!/Trade Confirmation/.test(text)) return null;
    const orderIdx = text.indexOf('Order details');
    const execIdx = text.indexOf('Execution details');
    const orderSection = execIdx > -1 ? text.slice(orderIdx, execIdx) : text.slice(orderIdx);
    const rowRe = /^(\S+)\s+(.+?)\s+([A-Z]{2}[A-Z0-9]{9}\d)\s+(Buy|Sell)\s+([\d.]+)\s+(.+?)\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s*$/;
    const lines = orderSection.split(/\r?\n/);
    let row = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(rowRe);
      if (m) { row = m; break; }
    }
    if (!row) return null;
    const ticker = row[1], name = row[2], isin = row[3], type = row[4], qtyStr = row[5], priceBlob = row[6], dateStr = row[7];
    const priceNums = [...priceBlob.matchAll(/([€$£])\s*([\d,]+\.?\d*)/g)];
    if (!priceNums.length) return null;
    const last = priceNums[priceNums.length - 1];
    const devise = REVOLUT_DEVISE_SYMBOLE[last[1]] || last[1];
    const montant = parseRevolutNum(last[2]);
    const qty = parseRevolutNum(qtyStr);
    return { date: parseRevolutDate(dateStr), type: type === 'Buy' ? 'achat' : 'vente', isin: isin, nom: name.trim(), qty: qty, prix: qty ? montant/qty : 0, devise: devise, montant: montant, montantDevise: devise };
  }
  // ── Revolut - Account Statement (variante EU/EUR "Trade - Market") ──
  // Relevé mensuel multi-opérations. Deux formats de "Account Statement"
  // existent chez Revolut (marques/courtiers différents dans le pied de
  // page) : celui-ci (Revolut Securities Europe, EUR, "Trade - Market")
  // est couvert ; un format plus ancien (Revolut Trading Ltd/DriveWealth,
  // USD, section "ACTIVITY" avec un tout autre format de ligne) ne l'est
  // pas encore, aucune valeur attendue vérifiée dessus.
  // Table "Positions" (Symbole Nom ISIN Quantité Cours Valeur %) juste
  // avant chaque table "EUR Transactions" : sert de dictionnaire
  // Symbole→ISIN/Nom pour enrichir les lignes de transaction, qui elles
  // n'ont que le symbole. Un titre entièrement revendu avant la fin de la
  // période n'apparaît plus dans "Positions" : repli sur le symbole seul
  // (ISIN vide), jamais deviné. Deux formats de ligne : "Cash top-up"
  // (dépôt, pas de symbole/quantité/cours) et "Trade - Market" (achat/
  // vente, avec symbole+quantité+cours+sens). Montant net = Valeur+Frais
  // +Commission pour un achat (coût total), Valeur-Frais-Commission pour
  // une vente (produit net), même convention que tous les autres
  // courtiers déjà couverts. Testé et exact contre le test officiel
  // Portfolio Performance (achat EMBH : brut 1.27 EUR + frais 0.03 EUR =
  // net 1.30 EUR).
  const REV_ACCT_MOIS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function parseRevAcctNum(s) { return parseFloat(String(s).replace(/,/g,'')); }
  function parseRevAcctDate(dateStr) {
    const m = dateStr.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!m) return '';
    const mois = REV_ACCT_MOIS[m[2].toLowerCase()];
    return String(m[1]).padStart(2,'0') + '/' + String(mois).padStart(2,'0') + '/' + m[3];
  }
  function parseRevolutAccountStatement(text) {
    const isinTable = {};
    const isinRowRe = /^(\S+)\s+(.+?)\s+([A-Z]{2}[A-Z0-9]{9}\d)\s+([\d.]+)\s+€[\d.,]+\s+€[\d.,]+\s+[\d.,]+%$/;
    text.split(/\r?\n/).forEach(function(line){
      const m = line.trim().match(isinRowRe);
      if (m) isinTable[m[1]] = { nom: m[2].trim(), isin: m[3] };
    });
    const transactions = [], mouvements = [];
    const depositRe = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+\d{2}:\d{2}:\d{2}\s+GMT\s+Cash top-up\s+€([\d.,]+)\s+€[\d.,]+\s+€[\d.,]+\s*$/;
    const tradeRe = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+\d{2}:\d{2}:\d{2}\s+GMT\s+(\S+)\s+Trade - Market\s+([\d.,]+)\s+€([\d.,]+)\s+(Buy|Sell)\s+€([\d.,]+)\s+€([\d.,]+)\s+€([\d.,]+)\s*$/;
    text.split(/\r?\n/).forEach(function(line){
      line = line.trim();
      let m = line.match(depositRe);
      if (m) {
        mouvements.push({ date: parseRevAcctDate(m[1]), libelle: 'Dépôt Revolut', debit: '', credit: parseRevAcctNum(m[2]) });
        return;
      }
      m = line.match(tradeRe);
      if (m) {
        const symbol = m[2];
        const info = isinTable[symbol] || { nom: symbol, isin: '' };
        const qty = parseRevAcctNum(m[3]);
        const prix = parseRevAcctNum(m[4]);
        const side = m[5];
        const valeur = parseRevAcctNum(m[6]);
        const frais = parseRevAcctNum(m[7]) + parseRevAcctNum(m[8]);
        const montant = side === 'Buy' ? valeur + frais : valeur - frais;
        transactions.push({ date: parseRevAcctDate(m[1]), type: side === 'Buy' ? 'achat' : 'vente', isin: info.isin, nom: info.nom, qty: qty, prix: prix, devise: 'EUR', montant: montant, montantDevise: 'EUR' });
      }
    });
    return { transactions: transactions, mouvements: mouvements };
  }
  function parseRevolutDocument(text) {
    if (!/Revolut/.test(text)) return null;
    const transactions = [], mouvements = [];
    if (/Trade Confirmation/.test(text)) {
      const t = parseRevolutTrade(text);
      if (t) transactions.push(t);
    } else if (/EUR Transactions|Account Statement/.test(text)) {
      const r = parseRevolutAccountStatement(text);
      transactions.push.apply(transactions, r.transactions);
      mouvements.push.apply(mouvements, r.mouvements);
    }
    return { transactions: transactions, mouvements: mouvements };
  }

  // ── Fortuneo / Arkéa Direct Bank - Relevé d'opérations ──────────────
  // Existe déjà en mode Portefeuille (lecture d'un instantané de
  // positions, COURTIERS id 'fortuneo') - ceci est une brique séparée
  // pour les documents opération-par-opération, indépendante. "AVIS
  // D'OPÉRATIONS" (achat, action ou OPCVM) et "AVIS D'ENCAISSEMENT
  // COUPON" (dividende, action ou OPCVM) couverts, testés et exacts
  // contre le test officiel Portfolio Performance (achat action 491.67
  // EUR, achat OPCVM 5931.63 EUR, dividende action 135.00 EUR, dividende
  // OPCVM 44.31 EUR). Un 3e type de document, "LIQUIDITES sur PEA" (relevé
  // de compte annuel où achats/dividendes apparaissent sans ISIN, en
  // simples lignes libellées), n'est volontairement PAS couvert, nettement
  // plus complexe (aucun identifiant fiable pour les titres) - pas encore
  // demandé, en attente si besoin.
  function parseFortuneoNum(s) { return parseFloat(String(s).replace(/\s/g,'').replace(',', '.')); }
  function parseFortuneoAchat(text) {
    if (!/AVIS D'OPÉRATIONS/.test(text)) return null;
    if (!/Sens\s+(Achat|Souscription)/.test(text)) return null;
    const typeMatch = text.match(/(ACTION|OPCVM)\s*:?\s*(.+?)\s*\(([A-Z]{2}[A-Z0-9]{9}\d)\)/);
    if (!typeMatch) return null;
    const nom = typeMatch[2].trim();
    const isin = typeMatch[3];
    const dateMatch = text.match(/(\d{2}-\d{2}-\d{4})\s+Référence/);
    const qtyPriceMatch = text.match(/Quantité\s+([\d.,]+)\s+(?:Cours|Val\. Liquidative)\s+([\d\s.,]+)\s*€/);
    const montantMatches = [...text.matchAll(/Montant NET\s+([\d\s.,]+)\s*€/g)];
    if (!dateMatch || !qtyPriceMatch || !montantMatches.length) return null;
    const montant = parseFortuneoNum(montantMatches[montantMatches.length-1][1]);
    return { date: dateMatch[1].replace(/-/g,'/'), type: 'achat', isin: isin, nom: nom, qty: parseFortuneoNum(qtyPriceMatch[1]), prix: parseFortuneoNum(qtyPriceMatch[2]), devise: 'EUR', montant: montant, montantDevise: 'EUR' };
  }
  function parseFortuneoDividende(text) {
    if (!/AVIS D'ENCAISSEMENT COUPON/.test(text)) return null;
    const typeMatch = text.match(/(ACTION|OPCVM)\s*:?\s*(.+?)\s*\(([A-Z]{2}[A-Z0-9]{9}\d)\)/);
    if (!typeMatch) return null;
    const nom = typeMatch[2].trim();
    const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
    const montantMatches = [...text.matchAll(/Montant Net\s+([\d\s.,]+)\s*€/g)];
    if (!dateMatch || !montantMatches.length) return null;
    const montant = parseFortuneoNum(montantMatches[0][1]);
    return { date: dateMatch[1], libelle: 'Dividende ' + nom, debit: '', credit: montant };
  }
  function parseFortuneoDocument(text) {
    const transactions = [], mouvements = [];
    if (/AVIS D'OPÉRATIONS/.test(text)) {
      const t = parseFortuneoAchat(text);
      if (t) transactions.push(t);
    } else if (/AVIS D'ENCAISSEMENT COUPON/.test(text)) {
      const d = parseFortuneoDividende(text);
      if (d) mouvements.push(d);
    } else {
      return null;
    }
    return { transactions: transactions, mouvements: mouvements };
  }

  // ── Suravenir / LINXEA AVENIR - Confirmation de versement ────────────
  // Seule la table "Répartition du versement" (page 1, la NOUVELLE
  // contribution) est utilisée - jamais "Répartition des unités de compte
  // après le versement" (page 2, un simple instantané du portefeuille
  // complet après coup, pas une nouvelle transaction), confirmé par le
  // test officiel Portfolio Performance (countBuySell=1, une seule ligne
  // alors que le vrai document liste plusieurs fonds au total sur le
  // contrat en page 2). Testé et exact contre le test officiel (LYXOR
  // STOXX50 : 90.1984 parts, 3000.00 EUR).
  function parseSuravenirNum(s) { return parseFloat(String(s).replace(/\s/g,'').replace(',', '.')); }
  function parseSuravenirVersement(text) {
    if (!/Confirmation de versement/.test(text)) return null;
    const dateMatch = text.match(/Date du versement\s*:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (!dateMatch) return null;
    const startIdx = text.indexOf('Répartition du versement');
    const endIdx = text.indexOf('Total', startIdx);
    if (startIdx === -1 || endIdx === -1) return null;
    const section = text.slice(startIdx, endIdx);
    const rowRe = /^(.+?)\s+([A-Z]{2}[A-Z0-9]{9}\d)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d\s.,]+?)\s+([\d\s.,]+?)\s+([\d\s.,]+)$/;
    const transactions = [];
    section.split(/\r?\n/).forEach(function(line){
      const m = line.trim().match(rowRe);
      if (!m) return;
      transactions.push({ date: dateMatch[1], type: 'achat', isin: m[2], nom: m[1].trim(), qty: parseSuravenirNum(m[5]), prix: parseSuravenirNum(m[4]), devise: 'EUR', montant: parseSuravenirNum(m[6]), montantDevise: 'EUR' });
    });
    return { transactions: transactions, mouvements: [] };
  }
  function parseSuravenirDocument(text) {
    if (!/Suravenir/.test(text)) return null;
    return parseSuravenirVersement(text) || { transactions: [], mouvements: [] };
  }

  // ── Trade Republic (multilingue FR/ES/EN, DE/IT à étendre plus tard) ──
  // Format d'origine allemande décliné dans la langue de l'utilisateur
  // libellés différents selon la langue mais structure identique. Ancrage
  // sur ce qui ne varie pas : ligne de données "NOM QTÉ unité PRIX DEVISE
  // MONTANT DEVISE" (identique pour achat/vente/dividende, seul le mot
  // d'unité change : titre(s)/tít./Pcs., à étendre pour Stk./pz. le jour
  // où des échantillons DE/IT arrivent), et la DERNIÈRE ligne "TOTAL ...
  // DEVISE" du document = montant final net après tout ajustement (frais,
  // conversion de devise), quel que soit le nombre de TOTAL intermédiaires
  // qui précèdent. Testé sur 4 vrais documents réels (achat programmé FR,
  // vente ES avec frais, dividende EN avec conversion USD→EUR, dépôt FR),
  // tous les montants recoupés à la main contre les documents sources
  // aucun test officiel Portfolio Performance disponible pour ces 4
  // documents précis (noms de fichiers différents de ceux du jeu de test).
  function parseTRNum(s) {
    s = String(s).trim();
    if (s.includes(',')) return parseFloat(s.replace(/\./g,'').replace(',', '.'));
    return parseFloat(s);
  }
  function parseTRDate(str) {
    const m = str.match(/(\d{2})[./](\d{2})[./](\d{4})/);
    return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
  }
  function trLastTotal(text) {
    const matches = [...text.matchAll(/TOTAL\s+(-?[\d.,]+)\s*([A-Z]{3})/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    return { montant: parseTRNum(last[1]), devise: last[2] };
  }
  function parseTRTrade(text) {
    const rowRe = /^(.+?)\s+([\d.,]+)\s*(?:titre\(s\)|t[íi]t\.|Pcs\.|Stk\.|St\.|pz\.)\s+([\d.,]+)\s*([A-Z]{3})\s+([\d.,]+)\s*([A-Z]{3})\s*$/;
    const lines = text.split(/\r?\n/);
    let row = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(rowRe);
      if (m) { row = m; break; }
    }
    if (!row) return null;
    const isinMatch = text.match(/ISIN\s*:?\s*([A-Z]{2}[A-Z0-9]{9}\d)/);
    if (!isinMatch) return null;
    const total = trLastTotal(text);
    if (!total) return null;
    const isVente = /LIQUIDACIÓN DE VALORES|Venta|Verkauf|Vendita|^Sell|Vente/i.test(text);
    const isDividende = /DIVIDEND|Dividende|Dividendo|Distribuzione/i.test(text);
    const dateMatch = text.match(/(?:le|a\s*d[íi]a|am|date de)\s+(\d{2}[./]\d{2}[./]\d{4})/i)
                    || text.match(/(?:BOOKING|BUCHUNG|RESERVA|R[ÉE]SERVATION)[\s\S]{0,120}?(\d{2}[./]\d{2}[./]\d{4})/i);
    const date = dateMatch ? parseTRDate(dateMatch[1]) : '';
    const type = isDividende ? 'dividende' : (isVente ? 'vente' : 'achat');
    const nom = row[1].trim();
    if (type === 'dividende') {
      return { kind: 'mouvement', date: date, libelle: ('Dividende ' + nom).trim(), debit: total.montant<0?Math.abs(total.montant):'', credit: total.montant>=0?total.montant:'' };
    }
    return { kind: 'transaction', date: date, type: type, isin: isinMatch[1], nom: nom, qty: parseTRNum(row[2]), prix: parseTRNum(row[3]), devise: row[4], montant: Math.abs(total.montant), montantDevise: total.devise };
  }
  function parseTRDeposit(text) {
    if (!/RÈGLEMENT DU VERSEMENT|Einzahlungsabrechnung/i.test(text)) return null;
    const total = trLastTotal(text);
    if (!total) return null;
    const dateMatch = text.match(/(?:BOOKING|BUCHUNG|RESERVA|R[ÉE]SERVATION)[\s\S]{0,120}?(\d{2}[./]\d{2}[./]\d{4})/i);
    const date = dateMatch ? parseTRDate(dateMatch[1]) : '';
    return { kind: 'mouvement', date: date, libelle: 'Dépôt Trade Republic', debit: '', credit: total.montant };
  }
  // ── Trade Republic - crypto (ABRECHNUNG CRYPTOGESCHÄFT / CRYPTO SPARPLAN) ──
  // Documents en allemand, distincts des achats/ventes actions (mêmes en-
  // têtes ABRECHNUNG mais types différents). Ligne de données : NOM
  // (TICKER) QTÉ Stk. PRIX DEVISE MONTANT DEVISE, identique achat/vente/
  // sparplan. Montant final signé toujours dans la section BUCHUNG
  // (VERRECHNUNGSKONTO ... DATE MONTANT), fiable même quand il n'y a pas
  // de ligne de frais (Sparplan) contrairement à un 2e GESAMT qui n'existe
  // pas toujours. Pas d'ISIN pour la crypto, le ticker (ETH/BTC) sert
  // d'identifiant. Testé sur 4 vrais documents (2 achats, 1 sparplan, 1
  // vente), tous les montants recoupés à la main.
  function parseTRCryptoNum(s) { return parseFloat(String(s).trim().replace(/\./g,'').replace(',', '.')); }
  function parseTRCryptoDate(str) {
    const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
  }
  function parseTRCrypto(text) {
    if (!/ABRECHNUNG CRYPTOGESCHÄFT|ABRECHNUNG CRYPTO SPARPLAN/.test(text)) return null;
    const isSell = /Verkauf/i.test(text);
    const rowRe = /^(.+?)\s+\(([A-Z]{2,6})\)\s+([\d.,]+)\s*Stk\.\s+([\d.,]+)\s*([A-Z]{3})\s+([\d.,]+)\s*([A-Z]{3})\s*$/;
    const lines = text.split(/\r?\n/);
    let row = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(rowRe);
      if (m) { row = m; break; }
    }
    if (!row) return null;
    const buchungIdx = text.indexOf('BUCHUNG');
    if (buchungIdx === -1) return null;
    const buchungSection = text.slice(buchungIdx, buchungIdx + 250);
    const buchungMatch = buchungSection.match(/[A-Z]{2}[A-Z0-9]+\s+(\d{2}\.\d{2}\.\d{4})\s+(-?[\d.,]+)\s*EUR/);
    if (!buchungMatch) return null;
    return { kind: 'transaction', date: parseTRCryptoDate(buchungMatch[1]), type: isSell ? 'vente' : 'achat', isin: row[2], nom: row[1].trim(), qty: parseTRCryptoNum(row[3]), prix: parseTRCryptoNum(row[4]), devise: row[5], montant: Math.abs(parseTRCryptoNum(buchungMatch[2])), montantDevise: 'EUR' };
  }
  function parseTradeRepublicDocument(text) {
    if (!/Trade Republic/i.test(text)) return null;
    const transactions = [], mouvements = [];
    const deposit = parseTRDeposit(text);
    if (deposit) { mouvements.push(deposit); return { transactions: transactions, mouvements: mouvements }; }
    const crypto = parseTRCrypto(text);
    if (crypto) { transactions.push(crypto); return { transactions: transactions, mouvements: mouvements }; }
    const trade = parseTRTrade(text);
    if (trade) {
      if (trade.kind === 'transaction') transactions.push(trade);
      else mouvements.push(trade);
    }
    return { transactions: transactions, mouvements: mouvements };
  }

  function parseHelloBankDocument(text) {
    if (!/Hellobank|Hello bank/i.test(text)) return null;
    const transactions = [], mouvements = [];
    if (/Geschäftsart:\s*(Kauf|Verkauf)/.test(text)) {
      const t = parseHelloBankTrade(text);
      if (t) transactions.push(t);
    } else if (/Geschäftsart:\s*Ertrag/.test(text)) {
      const d = parseHelloBankDividende(text);
      if (d) mouvements.push(d);
    } else if (/Lieferungen|Freier Erhalt/.test(text)) {
      const t = parseHelloBankInboundDelivery(text);
      if (t) transactions.push(t);
    }
    return { transactions: transactions, mouvements: mouvements };
  }

  // Routeur DEGIRO : distinct du routeur Saxo Bank, détecte la marque
  // (flatexDEGIRO / DEGIRO) et le type de document.
  function parseDegiroDocument(text) {
    if (!/DEGIRO/i.test(text)) return null;
    if (/^Account statement from \d{2}-\d{2}-\d{4} to \d{2}-\d{2}-\d{4}/m.test(text)) {
      return parseDegiroAccountStatement(text);
    }
    if (/^Dividend note\b/m.test(text)) {
      return parseDegiroDividendNote(text);
    }
    const transactions = [], mouvements = [];
    if (/^Transactions du \d{2}-\d{2}-\d{4} au \d{2}-\d{2}-\d{4}/m.test(text)) {
      transactions.push(...parseDegiroTransactions(text));
    }
    return { transactions, mouvements };
  }


  // Routeur : détecte la marque et le type de document.
  function parseSaxoBankDocument(text) {
    if (!/Saxo Bank/.test(text)) return null;
    const transactions = [], mouvements = [];
    if (/Trade Details Report|Bericht zu Trade-Details/.test(text)) {
      // La ligne Nettobetrag/Net Amount donne déjà le montant final dans la
      // devise du compte, conversion de devise déjà appliquée par Saxo
      // aucune logique de conversion à refaire ici, confirmé sur des
      // échantillons réels avec et sans conversion (taux ≠ 1,000000).
      const t = parseSaxoTradeSimple(text);
      if (t) transactions.push(t);
    } else if (/Cash Transfer Detail Report/.test(text)) {
      const m = parseSaxoCashTransfer(text);
      if (m) mouvements.push(m);
    } else if (/Kontoauszugsbericht/.test(text)) {
      mouvements.push(...parseSaxoKontoauszug(text));
    } else if (/Corporate Action Detail Report/.test(text)) {
      const d = parseSaxoCorporateAction(text);
      if (d) mouvements.push(d);
    } else if (/Cash Amount Detail Report/.test(text)) {
      const i = parseSaxoCashAmount(text);
      if (i) mouvements.push(i);
    }
    return { transactions, mouvements };
  }

  function parseReleveOperationsBourseDirect(text) {
    const lines = text.split(/\r?\n/);
    const dateRe = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(.+)$/;
    const opTypes = ['ACHAT COMPTANT','ACHAT ETRANGER','VENTE COMPTANT','VENTE ETRANGER','COUPONS','INVESTISSEMENT ESPECES','VIREMENT ESPECES','TAXE TRANSACT FINANCIERES','DROITS DE GARDE'];
    const transactions = [];
    const mouvements = [];
    const parseNum = s => parseFloat(String(s).replace(/\s/g,'').replace(',', '.'));

    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(dateRe);
      if (!m) { i++; continue; }
      const date = m[1];
      const rest = m[2];
      const opMatch = opTypes.find(t => rest.startsWith(t));
      if (!opMatch) { i++; continue; }
      // Les "colonnes" (type/ISIN/libellé/montant) sont séparées par au moins
      // 2 espaces dans le texte source ; le montant lui-même ne contient
      // jamais qu'UN espace (séparateur de milliers, ex. "4 090,80"). Découper
      // sur 2+ espaces évite qu'un nombre présent DANS le libellé (ex. "STOXX
      // 600") ne soit avalé par erreur dans le montant.
      const cols = rest.slice(opMatch.length).trim().split(/\s{2,}/).filter(Boolean);
      let isin = '', label = '', montant = null;
      const isinRe = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
      if (cols.length && isinRe.test(cols[0])) { isin = cols.shift(); }
      if (cols.length) {
        const last = cols[cols.length - 1];
        if (/^[\d\s]+,\d{2}$/.test(last)) { montant = parseNum(last); cols.pop(); }
        label = cols.join(' ').trim();
      }

      let qty = null, cours = null;
      let j = i + 1;
      while (j < lines.length && !dateRe.test(lines[j]) && lines[j].trim() && !/^Sous réserve/.test(lines[j])) {
        const l = lines[j];
        let mm;
        if ((mm = l.match(/QUANTITE\s*:\s*([+-]?[\d\s]+)/))) qty = parseInt(mm[1].replace(/\s/g,''),10);
        if ((mm = l.match(/COURS\s*:\s*\+?([\d.,]+)\s+BRUT\s*:\s*\+?([\d.,]+)/))) cours = parseNum(mm[1]);
        if ((mm = l.match(/PX UN\.BRUT\s*:\s*\+?([\d.,]+)\s+BRUT\s*:\s*\+?([\d.,]+)/))) cours = parseNum(mm[1]);
        j++;
      }

      if (opMatch === 'ACHAT COMPTANT' || opMatch === 'ACHAT ETRANGER') {
        transactions.push({ date, type: 'achat', isin, nom: label, qty: Math.abs(qty||0), prix: cours||0, montant, devise: 'EUR' });
      } else if (opMatch === 'VENTE COMPTANT' || opMatch === 'VENTE ETRANGER') {
        transactions.push({ date, type: 'vente', isin, nom: label, qty: Math.abs(qty||0), prix: cours||0, montant, devise: 'EUR' });
      } else if (opMatch === 'COUPONS') {
        mouvements.push({ date, libelle: `Dividende ${label}`.trim(), debit: '', credit: montant });
      } else if (opMatch === 'INVESTISSEMENT ESPECES' || opMatch === 'VIREMENT ESPECES') {
        mouvements.push({ date, libelle: label, debit: '', credit: montant });
      } else if (opMatch === 'TAXE TRANSACT FINANCIERES') {
        mouvements.push({ date, libelle: `Taxe transactions financières ${label}`.trim(), debit: montant, credit: '' });
      } else if (opMatch === 'DROITS DE GARDE') {
        mouvements.push({ date, libelle: `Droits de garde ${label}`.trim(), debit: montant, credit: '' });
      }
      i = j;
    }
    return { transactions, mouvements };
  }

  function analyserTexte(text){
    const ibkr=parseIBKRDocument(text);
    const chain=[
      ['Interactive Brokers',()=>ibkr],
      ['DEGIRO',()=>parseDegiroDocument(text)],
      ['HelloBank',()=>parseHelloBankDocument(text)],
      ['Saxo Bank',()=>parseSaxoBankDocument(text)],
      ['N26',()=>parseN26Document(text)],
      ['Boursorama',()=>parseBoursoDocument(text)],
      ['Revolut',()=>parseRevolutDocument(text)],
      ['Fortuneo',()=>parseFortuneoDocument(text)],
      ['Suravenir',()=>parseSuravenirDocument(text)],
      ['Trade Republic',()=>parseTradeRepublicDocument(text)],
      ['Bourse Direct',()=>parseReleveOperationsBourseDirect(text)]
    ];
    for(const c of chain){let r=null;try{r=c[1]()}catch(e){r=null}
      if(r&&((r.transactions&&r.transactions.length)||(r.mouvements&&r.mouvements.length)))return{courtier:c[0],transactions:r.transactions||[],mouvements:r.mouvements||[]}}
    return{courtier:'',transactions:[],mouvements:[]};
  }
  let pdfjsP=null;
  function chargerPdfjs(){
    if(pdfjsP)return pdfjsP;
    pdfjsP=import('./pdf/pdf.min.mjs').then(m=>{m.GlobalWorkerOptions.workerSrc=new URL('./pdf/pdf.worker.min.mjs',location.href).href;return m}).catch(e=>{pdfjsP=null;throw e});
    return pdfjsP;
  }
  async function elementsPdf(buf){
    const lib=await chargerPdfjs();
    const pdf=await lib.getDocument({data:buf,isEvalSupported:false}).promise;
    const elements=[];
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p),vp=page.getViewport({scale:1}),content=await page.getTextContent();
      for(const it of content.items){
        if(!it.str||!it.str.trim())continue;
        elements.push({text:it.str,x:Math.round(it.transform[4]),y:Math.round(it.transform[5]),yTop:Math.round(vp.height-it.transform[5]),width:Math.round(it.width),height:Math.round(it.height),fontName:it.fontName||'',page:p});
      }
    }
    return elements;
  }
  async function lireFichier(file){
    const nom=(file.name||'').toLowerCase();
    let text;
    if(/\.(xml|txt|csv)$/.test(nom)||/xml|text/.test(file.type||'')){text=await file.text()}
    else{const els=await elementsPdf(await file.arrayBuffer());text=_bankReconstructLines(els).map(l=>l.text).join('\n')}
    const r=analyserTexte(text);r.nom=file.name||'';r.longueur=text.length;return r;
  }
  window.KYFPDF={lire:lireFichier,analyser:analyserTexte,version:1};
})();
